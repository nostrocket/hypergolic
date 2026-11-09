import {captureMcp,cvmRecord,CvmError,mcpKey,cvmCancellationKey,type McpMessage,type CvmObject,type CvmOptions} from './cvm-contract.ts';
import {CvmStreamReceiver} from './cvm-stream.ts';
import type {CvmNativeSession,CvmPermit} from './cvm-session.ts';
/** Private native delivery only, after outer+inner authentication to this connection's exact provider. */
export type CvmAuthenticated=Readonly<{message:unknown;eventId:string;references:readonly string[];paymentInteraction?:'explicit_gating'|'transparent'}>;
export type CvmPurpose='approved'|'initialize'|'initialized'|'stream-control';
export interface CvmBytePort{
  /** Native prepare yields the inner ID before commit can emit; native relay ACK is a separate callback. */
  publish(permit:CvmPermit,purpose:CvmPurpose,message:McpMessage,replyTo:string|null,deadline:number,signal:AbortSignal,
    prepared:(eventId:string)=>void,acknowledged:()=>void):Promise<void>;
  onMessage(handler:(value:CvmAuthenticated)=>void):()=>void;
  onClosed(handler:()=>void):()=>void;
  close():Promise<void>;
}
type Pending={message:McpMessage;permit:CvmPermit;purpose:CvmPurpose;deadline:number;signal:AbortSignal;options:CvmOptions;eventId:string|null;early:CvmAuthenticated[];
  token:string|null;stream:CvmStreamReceiver|null;controls:number;accepted:boolean;resolve:(message:McpMessage)=>void;reject:(error:CvmError)=>void};
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const protocol='2025-06-18';
/** Trusted owning MCP client. This type/port is not authority; the native source permit remains final. */
export class CvmMcpClient implements CvmNativeSession{
  private readonly pending=new Map<string,Pending>();
  private readonly incoming=new Map<string,string>();
  private readonly events=new Set<(message:unknown)=>void>();
  private readonly closedHandlers=new Set<(reason?:CvmError,completedPermits?:ReadonlySet<string>)=>void>();
  private readonly completed=new Set<string>();
  private readonly off:()=>void;
  private closed=false;
  private initialized=false;
  private initializing:Promise<void>|null=null;
  private mode:'explicit_gating'|'transparent'|null=null;
  private readonly ended:Promise<never>;
  private rejectEnded!:(error:CvmError)=>void;
  private closing:Promise<void>|null=null;
  private probe=0;
  private readonly port:CvmBytePort;
  private readonly now:()=>number;
  private readonly nonce:()=>string;
  constructor(port:CvmBytePort,now:()=>number,nonce:()=>string=()=>crypto.randomUUID()){
    this.port=port;this.now=now;this.nonce=nonce;
    this.ended=new Promise<never>((_,reject)=>{this.rejectEnded=reject;});void this.ended.catch(()=>{});
    const offMessage=port.onMessage(value=>{try{this.receive(value);}catch{this.terminate(new CvmError('invalid message'));}});
    const offClosed=port.onClosed(()=>this.terminate(new CvmError('session closed')));
    this.off=()=>{offMessage();offClosed();};
    if(this.closed)this.off();
  }
  private current(deadline:number,signal:AbortSignal,accepted=false):void{
    if(this.closed&&!accepted||signal.aborted)throw new CvmError('session closed');
    if(this.now()>=deadline)throw new CvmError('relay timeout');
  }
  async request(permit:CvmPermit,value:McpMessage,deadline:number,signal:AbortSignal,options:CvmOptions):Promise<McpMessage|null>{
    const message=captureMcp(value);this.current(deadline,signal);this.cancellation(message);
    if(this.completed.has(permit.token)||[...this.pending.values()].some(pending=>pending.permit.token===permit.token))throw new CvmError('policy denied');
    if(options.initialize&&!this.initialized){
      this.initializing??=this.initialize(permit,deadline,signal,options,message.id);
      await this.initializing;this.current(deadline,signal);this.cancellation(message);
    }
    if(message.method!==undefined&&message.id!==undefined)return this.call(permit,message,'approved',deadline,signal,options);
    const key=message.method===undefined?mcpKey(message.id!):null;
    const replyTo=key?this.incoming.get(key):null;
    if(key&&!replyTo)throw new CvmError('invalid message');
    const receipt=await this.publish(permit,'approved',message,replyTo??null,deadline,signal);
    this.current(deadline,signal,this.completed.has(permit.token));if(!hex(receipt.eventId))throw new CvmError('invalid message');
    if(key)this.incoming.delete(key);return null;
  }
  private async initialize(permit:CvmPermit,deadline:number,signal:AbortSignal,options:CvmOptions,callerId?:string|number):Promise<void>{
    try{
      const internalId=this.initializationId(callerId);
      const result=await this.call(permit,captureMcp({jsonrpc:'2.0',id:internalId,method:'initialize',params:{
        protocolVersion:protocol,capabilities:{},clientInfo:{name:'Hypergolic',version:'1'}}}),'initialize',deadline,signal,options);
      if(result.error||result.result?.protocolVersion!==protocol||!result.result.capabilities||typeof result.result.capabilities!=='object'||Array.isArray(result.result.capabilities))throw new CvmError('initialization failed');
      const receipt=await this.publish(permit,'initialized',captureMcp({jsonrpc:'2.0',method:'notifications/initialized'}),null,deadline,signal);
      this.current(deadline,signal);if(!hex(receipt.eventId))throw new CvmError('initialization failed');this.initialized=true;
    }catch(error){this.terminate(new CvmError('initialization failed'));throw error;}
  }
  private initializationId(callerId:unknown):string{
    for(let attempt=0;attempt<2;attempt++){
      const nonce=this.nonce().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce))throw new CvmError('initialization failed');
      const id='hypergolic:init:'+nonce;if(id!==callerId)return id;
    }
    throw new CvmError('initialization failed');
  }
  private cancellation(message:McpMessage):void{
    const key=cvmCancellationKey(message);if(key===null)return;
    const target=this.pending.get(key);
    if(!target||target.purpose!=='approved'||target.accepted||!target.eventId)throw new CvmError('invalid message');
    this.current(target.deadline,target.signal);
  }
  private async call(permit:CvmPermit,message:McpMessage,purpose:CvmPurpose,deadline:number,signal:AbortSignal,options:CvmOptions):Promise<McpMessage>{
    const key=mcpKey(message.id!);if(this.pending.has(key)||this.pending.size>=2)throw new CvmError('policy denied');
    let resolve!:(message:McpMessage)=>void,reject!:(error:CvmError)=>void;
    const response=new Promise<McpMessage>((yes,no)=>{resolve=yes;reject=no;});void response.catch(()=>{});
    const meta=message.params?._meta;
    const token=meta&&typeof meta==='object'&&!Array.isArray(meta)?(meta as CvmObject).progressToken:undefined;
    const pending:Pending={message,permit,purpose,deadline,signal,options,eventId:null,early:[],token:typeof token==='string'||typeof token==='number'?mcpKey(token):null,
      stream:typeof token==='string'||typeof token==='number'?new CvmStreamReceiver(token,this.now):null,controls:0,accepted:false,resolve,reject};
    this.pending.set(key,pending);
    const abort=()=>reject(new CvmError('session closed'));
    const timer=setTimeout(()=>reject(new CvmError('relay timeout')),Math.max(0,deadline-this.now()));
    const heartbeat=setInterval(()=>{
      if(this.pending.get(key)!==pending)return;
      try{this.current(deadline,signal);for(const control of pending.stream?.idle('probe-'+(++this.probe))??[])this.control(pending,control);}
      catch{reject(new CvmError('relay timeout'));}
    },1000);
    signal.addEventListener('abort',abort,{once:true});
    try{
      this.current(deadline,signal);
      const sending=this.port.publish(permit,purpose,message,null,deadline,signal,eventId=>{
        this.current(deadline,signal);if(pending.eventId||!hex(eventId))throw new CvmError('invalid message');pending.eventId=eventId;
        for(const early of pending.early.splice(0))this.receive(early);
      },()=>{if(!pending.eventId)throw new CvmError('invalid message');});
      // A fully authenticated matching RPC response is decisive even if the relay ACK is lost.
      void sending.then(()=>{if(!pending.eventId&&!pending.accepted)reject(new CvmError('invalid message'));},()=>{if(!pending.accepted)reject(new CvmError('provider unavailable'));});
      const result=await response;this.current(deadline,signal,pending.accepted);return result;
    }catch(error){this.terminate(error instanceof CvmError?error:new CvmError('provider unavailable'));throw error;}
    finally{clearTimeout(timer);clearInterval(heartbeat);signal.removeEventListener('abort',abort);if(this.pending.get(key)===pending)this.pending.delete(key);}
  }
  private receive(value:CvmAuthenticated):void{
    if(this.closed)return;
    const row=cvmRecord(value,['message','eventId','references'],['paymentInteraction']);
    if(!hex(row.eventId)||!Array.isArray(row.references)||row.references.length>16||!row.references.every(hex))throw new CvmError('invalid message');
    const message=captureMcp(row.message),references=row.references as string[],referenceSet=new Set(references);
    if(row.paymentInteraction!==undefined&&!['explicit_gating','transparent'].includes(row.paymentInteraction as string))throw new CvmError('invalid message');
    this.mode??=(row.paymentInteraction??'transparent') as 'explicit_gating'|'transparent';
    if(row.paymentInteraction!==undefined&&row.paymentInteraction!==this.mode)throw new CvmError('policy denied');
    const awaiting=message.method===undefined?this.pending.get(mcpKey(message.id!)):
      ['notifications/payment_required','notifications/progress'].includes(message.method)?[...this.pending.values()].find(item=>!item.eventId):undefined;
    if(awaiting&&!awaiting.eventId){
      if(awaiting.early.length>=4)throw new CvmError('policy denied');
      awaiting.early.push(Object.freeze({message,eventId:row.eventId,references:Object.freeze([...references]),...(row.paymentInteraction===undefined?{}:{paymentInteraction:row.paymentInteraction as 'explicit_gating'|'transparent'})}));return;
    }
    if(message.method===undefined){
      const pending=this.pending.get(mcpKey(message.id!));if(!pending)return;
      if(!pending.eventId)throw new CvmError('invalid message');
      if(!referenceSet.has(pending.eventId))throw new CvmError('invalid message');
      this.current(pending.deadline,pending.signal);pending.stream?.final();
      if(message.error?.code===-32042){pending.reject(this.payment(pending));return;}
      if(pending.purpose==='approved')this.remember(pending.permit);pending.accepted=true;pending.resolve(message);return;
    }
    if(message.method==='notifications/payment_required'){
      for(const pending of this.pending.values())if(pending.eventId&&referenceSet.has(pending.eventId))pending.reject(this.payment(pending));return;
    }
    if(message.method==='notifications/cancelled'){const key=cvmCancellationKey(message)!;if(!this.incoming.delete(key))return;this.emit(message);return;}
    if(message.method==='notifications/progress'){
      const token=message.params?.progressToken;if(typeof token!=='string'&&typeof token!=='number')throw new CvmError('invalid message');
      const pending=[...this.pending.values()].find(item=>item.token===mcpKey(token));if(!pending)return;
      this.current(pending.deadline,pending.signal);
      if(message.params?.cvm!==undefined){const result=pending.stream!.receive(message);for(const item of result.send)this.control(pending,item);for(const item of result.deliver)this.emit(item);return;}
    }
    if(message.id!==undefined){const key=mcpKey(message.id);if(this.incoming.has(key)||this.incoming.size>=32)throw new CvmError('policy denied');this.incoming.set(key,row.eventId);}
    this.emit(message);
  }
  private payment(pending:Pending):CvmError{return new CvmError(pending.options.payment==='prompt'?'payment required':'payment denied');}
  private control(pending:Pending,message:McpMessage):void{
    this.current(pending.deadline,pending.signal);if(pending.controls>=4)throw new CvmError('policy denied');pending.controls++;
    void this.publish(pending.permit,'stream-control',message,null,pending.deadline,pending.signal).then(receipt=>{
      if(!hex(receipt.eventId))throw new CvmError('invalid message');
    }).catch(()=>{if([...this.pending.values()].includes(pending))this.terminate(new CvmError('session closed'));}).finally(()=>{pending.controls--;});
  }
  private async publish(permit:CvmPermit,purpose:CvmPurpose,message:McpMessage,replyTo:string|null,deadline:number,signal:AbortSignal):Promise<Readonly<{eventId:string}>>{
    this.current(deadline,signal);
    let reject!:(error:CvmError)=>void;
    const ended=new Promise<never>((_,no)=>{reject=no;});
    const abort=()=>reject(new CvmError('session closed'));
    const timer=setTimeout(()=>reject(new CvmError('relay timeout')),Math.max(0,deadline-this.now()));
    signal.addEventListener('abort',abort,{once:true});
    let eventId:string|null=null,acknowledged=false;
    try{
      const sending=this.port.publish(permit,purpose,message,replyTo,deadline,signal,value=>{
        this.current(deadline,signal);this.cancellation(message);if(eventId||!hex(value))throw new CvmError('invalid message');eventId=value;
      },()=>{if(!eventId||acknowledged)throw new CvmError('invalid message');acknowledged=true;if(purpose==='approved')this.remember(permit);});
      try{await Promise.race([sending,ended,this.ended]);}
      catch(error){if(!eventId||!acknowledged)throw error;}
      if(!eventId||!acknowledged)throw new CvmError('invalid message');this.current(deadline,signal,purpose==='approved');return{eventId};
    }
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  private emit(message:McpMessage):void{for(const handler of this.events){try{handler(message);}catch{/* Listener failures do not change transport bookkeeping. */}}}
  onEvent(handler:(message:unknown)=>void):()=>void{if(this.closed)throw new CvmError('session closed');this.events.add(handler);return()=>{this.events.delete(handler);};}
  private remember(permit:CvmPermit):void{if(this.completed.size>=1024&&!this.completed.has(permit.token))throw new CvmError('policy denied');this.completed.add(permit.token);}
  onClosed(handler:(reason?:CvmError,completedPermits?:ReadonlySet<string>)=>void):()=>void{if(this.closed){handler(new CvmError('session closed'),new Set(this.completed));return()=>{};}this.closedHandlers.add(handler);return()=>{this.closedHandlers.delete(handler);};}
  private terminate(error:CvmError):void{
    if(this.closed)return;this.closed=true;this.rejectEnded(error);this.off?.();for(const pending of this.pending.values())pending.reject(error);this.pending.clear();this.incoming.clear();
    for(const handler of this.closedHandlers){try{handler(error,new Set(this.completed));}catch{/* One listener cannot suppress another endpoint's terminal. */}}
    this.events.clear();this.closedHandlers.clear();this.closing??=Promise.resolve().then(()=>this.port.close());void this.closing.catch(()=>{});
  }
  async close():Promise<void>{this.terminate(new CvmError('session closed'));await this.closing;}
}
