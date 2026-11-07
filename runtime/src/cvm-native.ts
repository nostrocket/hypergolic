import {parseCvmOperation,captureMcp,cvmFailure,CvmError,CVM_OPERATIONS,cvmMetadata,type CvmOperation} from '../../src/cvm/cvm-contract';
import type {NativeHost} from './native-client';
type Row={id:string;type:string;timer:number;resolve:(value:Readonly<Record<string,unknown>>)=>void;reject:()=>void};
/** Separate long-lived native lane; it shares sequence ownership but never borrows ordinary request/focus slots. */
export function createCvmNative(native:NativeHost,generation:string,next:()=>number,deliver:(message:unknown)=>void){
  const pending=new Map<number,Row>();let closed=false;
  function receive(raw:unknown):void{
    if(closed||typeof raw!=='string'||new TextEncoder().encode(raw).length>80*1024)return;
    try{
      const value=JSON.parse(raw);if(!value||value.sessionId!==generation)return;
      if(value.type==='cvm.event'){
        if(Object.keys(value).length!==3||typeof value.message!=='string')return;
        const event=JSON.parse(value.message);if(event?.type!=='cvm.event'||Object.keys(event).length!==3)return;
        captureMcp(event.message);deliver(event);return;
      }
      if(value.type!=='cvm.response'||Object.keys(value).length!==4||!Number.isSafeInteger(value.sequence))return;
      const row=pending.get(value.sequence);if(!row)return;
      pending.delete(value.sequence);window.clearTimeout(row.timer);
      try{const message=typeof value.response==='string'?JSON.parse(value.response):null;
        if(!message||message.id!==row.id||message.type!==row.type+'.result')throw new Error('CVM response mismatch');row.resolve(message);
      }catch{row.reject();}
    }catch{/* A malformed native envelope has no recipient. */}
  }
  const android=(event:{data:unknown})=>receive(event.data);
  const ios=(event:MessageEvent)=>{if(event.isTrusted&&event.source===window&&event.data?.type==='hypergolic.native-response'&&Object.keys(event.data).length===2)receive(event.data.message);};
  native.addEventListener?.('message',android);window.addEventListener('message',ios);
  return Object.freeze({
    async request(value:unknown):Promise<Readonly<Record<string,unknown>>>{
      const request=parseCvmOperation(value);
      if(closed||pending.size>=4)throw new CvmError('policy denied');
      const sequence=next(),timeout=request.type==='cvm.request'?request.options.timeoutMs:30000;
      const carrier=request.type==='cvm.request'?{...request,message:JSON.stringify(request.message),...cvmMetadata(request.message)}:request;
      const encoded=JSON.stringify({type:'cvm',sessionId:generation,sequence,message:JSON.stringify(carrier)});
      if(new TextEncoder().encode(encoded).length>80*1024)throw new CvmError('invalid request');
      return new Promise((resolve,reject)=>{
        const timer=window.setTimeout(()=>{pending.delete(sequence);reject(new CvmError('relay timeout'));},timeout+1000);
        pending.set(sequence,{type:request.type,id:request.id,timer,resolve,reject:()=>reject(new CvmError('session closed'))});
        try{native.postMessage(encoded);}catch{pending.delete(sequence);window.clearTimeout(timer);reject(new CvmError('session closed'));}
      });
    },
    destroy(){closed=true;native.removeEventListener?.('message',android);window.removeEventListener('message',ios);for(const row of pending.values()){window.clearTimeout(row.timer);row.reject();}pending.clear();},
  });
}
/** Public input never receives a private native token or a source-config field. */
export function createCvmGuestReceiver(source:Window,call:(value:unknown)=>Promise<Readonly<Record<string,unknown>>>,live:()=>boolean){
  return (value:unknown):void=>{
    if(!live()||!value||typeof value!=='object'||!CVM_OPERATIONS.includes((value as {type?:string}).type??''))return;
    let request:CvmOperation;
    try{request=parseCvmOperation(value);}catch(error){
      const row=value as {id?:unknown;type?:unknown};if(typeof row?.id==='string'&&row.id.length<=128&&typeof row.type==='string')source.postMessage(cvmFailure(row.type,row.id,error),'*');return;
    }
    void call(request).then(reply=>{if(live())source.postMessage(reply,'*');},error=>{if(live())source.postMessage(cvmFailure(request.type,request.id,error),'*');});
  };
}
