import {captureMcp,CvmError,CVM_LIMITS,mcpKey,type McpId,type McpMessage,type CvmObject} from './cvm-contract.ts';
import type {JsonValue} from '../routing/routing-contract.ts';
export type CvmStreamResult=Readonly<{deliver:readonly McpMessage[];send:readonly McpMessage[];terminal:boolean}>;
const failed=():never=>{throw new CvmError('policy denied');};
/** Receiver state for one authenticated server/request progress token. Overall request deadline is owned elsewhere. */
export class CvmStreamReceiver{
  private started=false;
  private broken=false;
  private aborted=false;
  private terminal=false;
  private received=0;
  private sent=0;
  private next=0;
  private payload=0;
  private lastActivity:number;
  private ping:Readonly<{nonce:string;expires:number}>|null=null;
  private readonly gaps=new Map<number,McpMessage>();
  private readonly token:McpId;
  private readonly now:()=>number;
  constructor(token:McpId,now:()=>number){this.token=token;this.now=now;this.lastActivity=now();}
  private frame(frameType:string,fields:CvmObject={}):McpMessage{
    return captureMcp({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:this.token,progress:++this.sent,cvm:{type:'open-stream',frameType,...fields}}});
  }
  receive(value:unknown):CvmStreamResult{
    if(this.broken)return failed();
    if(this.terminal)return Object.freeze({deliver:[],send:[],terminal:true});
    try{return this.accept(value);}catch(error){this.broken=true;this.terminal=true;this.gaps.clear();throw error;}
  }
  private accept(value:unknown):CvmStreamResult{
    const message=captureMcp(value),params=message.params;
    if(params&&typeof params.progressToken!=='string'&&!(typeof params.progressToken==='number'&&Number.isSafeInteger(params.progressToken)))return failed();
    if(message.method!=='notifications/progress'||!params||mcpKey(params.progressToken as McpId)!==mcpKey(this.token))return Object.freeze({deliver:[],send:[],terminal:this.terminal});
    const raw=params.cvm;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return failed();
    const frame=raw as CvmObject;
    if(frame.type!=='open-stream'||typeof frame.frameType!=='string')return failed();
    if(this.terminal)return Object.freeze({deliver:[],send:[],terminal:true});
    if(typeof params.progress!=='number'||!Number.isFinite(params.progress)||params.progress<=this.received)return failed();
    if(!this.started&&(frame.frameType!=='start'||params.progress!==1))return failed();
    this.received=params.progress;this.lastActivity=this.now();
    const send:McpMessage[]=[],deliver:McpMessage[]=[];
    switch(frame.frameType){
      case 'start':
        if(this.started)return failed();this.started=true;send.push(this.frame('accept'));deliver.push(message);break;
      case 'chunk':this.chunk(message,frame,deliver);break;
      case 'ping':send.push(this.frame('pong',{nonce:this.nonce(frame.nonce)}));break;
      case 'pong':{
        const nonce=this.nonce(frame.nonce);
        if(!this.ping||nonce!==this.ping.nonce||this.now()>=this.ping.expires)return failed();
        this.ping=null;break;
      }
      case 'close':
        if(this.gaps.size||frame.lastChunkIndex!==undefined&&(!Number.isSafeInteger(frame.lastChunkIndex)||frame.lastChunkIndex!==this.next-1)||this.next===0&&frame.lastChunkIndex!==undefined)return failed();
        this.terminal=true;deliver.push(message);break;
      case 'abort':this.aborted=true;this.terminal=true;this.gaps.clear();deliver.push(message);break;
      default:return failed();
    }
    return Object.freeze({deliver:Object.freeze(deliver),send:Object.freeze(send),terminal:this.terminal});
  }
  private nonce(value:JsonValue|undefined):string{
    if(typeof value!=='string'||!value.length||new TextEncoder().encode(value).length>CVM_LIMITS.nonceBytes)return failed();return value;
  }
  private chunk(message:McpMessage,frame:CvmObject,deliver:McpMessage[]):void{
    const index=frame.chunkIndex;
    if(!Number.isSafeInteger(index)||(index as number)<this.next||(index as number)>this.next+CVM_LIMITS.reorderFrames||this.gaps.has(index as number)||!Object.prototype.hasOwnProperty.call(frame,'data'))return failed();
    this.payload+=new TextEncoder().encode(JSON.stringify(frame.data)).length;
    if(this.payload>CVM_LIMITS.streamBytes||this.gaps.size>=CVM_LIMITS.reorderFrames)return failed();
    this.gaps.set(index as number,message);
    while(this.gaps.has(this.next)){deliver.push(this.gaps.get(this.next)!);this.gaps.delete(this.next++);}
  }
  idle(nonce:string):readonly McpMessage[]{
    if(this.broken)return failed();
    if(!this.started||this.terminal)return[];
    if(this.ping){if(this.now()>=this.ping.expires){this.broken=true;this.terminal=true;this.gaps.clear();return failed();}return[];}
    if(this.now()-this.lastActivity<10_000)return[];
    this.ping=Object.freeze({nonce:this.nonce(nonce),expires:this.now()+5_000});return[this.frame('ping',{nonce})];
  }
  final():void{
    if(this.broken||this.aborted||this.started&&!this.terminal||this.gaps.size){this.broken=true;this.terminal=true;this.gaps.clear();failed();}
  }
}
