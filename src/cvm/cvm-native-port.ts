import {CvmMcpClient,type CvmAuthenticated,type CvmBytePort} from './cvm-client.ts';
import {captureMcp,cvmMetadata,captureOptions,captureServer,cvmRecord,cvmText,CvmError} from './cvm-contract.ts';
import type {CvmHostPort,CvmIngress} from './cvm-service.ts';
import type {CvmPermit,CvmNativeSession,CvmScope} from './cvm-session.ts';
export interface CvmHostModule {
  takeCvmRequest(token:string):string|null;isCvmSourceCurrent(generation:string,sourceRevision:string):boolean;
  approveCvmRequest(token:string):string|null;rejectCvmRequest(token:string):void;
  finishCvmRequest(token:string,response:string|null):void;sendCvmEvent(generation:string,sourceRevision:string,requestToken:string,response:string):boolean;
  synchronizeCvmRelays(relays:readonly string[]):void;
}
export interface CvmSignerModule {
  openCvmSession(permit:string):Promise<string>;
  prepareCvmMessage(session:string,permit:string,purpose:string,message:string,replyTo:string|null):Promise<string>;
  commitCvmMessage(session:string,plan:string):Promise<void>;closeCvmSession(session:string):void;
  addListener(event:'onCvmMessage'|'onCvmClosed',handler:(event:unknown)=>void):{remove():void};
}
const opaque=(value:unknown):string=>{const result=cvmText(value,128);if(!/^[A-Za-z0-9_-]+$/.test(result))throw new CvmError('invalid request');return result;};
const hex=(value:unknown):string=>{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new CvmError('invalid request');return value;};
export function captureCvmIngress(raw:string,token:string):CvmIngress{
  if(new TextEncoder().encode(raw).length>80*1024)throw new CvmError('invalid request');
  const row=cvmRecord(JSON.parse(raw),['token','scope','requestId','server','message','operation','progressTokenJSON','options','remainingMs']);
  if(row.token!==token||typeof row.remainingMs!=='number'||!Number.isFinite(row.remainingMs)||row.remainingMs<=0||row.remainingMs>120000||typeof row.message!=='string')throw new CvmError('invalid request');
  const source=cvmRecord(row.scope,['endpoint','generation','sourceRevision','identity','epoch','publisher','appId','version','instance']);
  if(!Number.isSafeInteger(source.epoch)||(source.epoch as number)<0)throw new CvmError('invalid request');
  const scope:CvmScope=Object.freeze({endpoint:opaque(source.endpoint),generation:opaque(source.generation),sourceRevision:opaque(source.sourceRevision),identity:hex(source.identity),epoch:source.epoch as number,
    publisher:hex(source.publisher),appId:cvmText(source.appId,1024),version:hex(source.version),instance:opaque(source.instance)});
  const metadata=cvmMetadata(captureMcp(JSON.parse(row.message)));
  if(row.operation!==metadata.operation||row.progressTokenJSON!==metadata.progressTokenJSON)throw new CvmError('invalid request');
  return Object.freeze({token,scope,requestId:cvmText(row.requestId),server:captureServer(row.server),message:row.message,...metadata,options:captureOptions(row.options),remainingMs:row.remainingMs});
}
/** Attempt both native revocations even when one bridge reporter is unavailable. */
function revokeCvm(host:CvmHostModule,signer:CvmSignerModule,session:string,token:string):Readonly<{error:unknown}>|null{
  let failure:Readonly<{error:unknown}>|null=null;
  try{host.finishCvmRequest(token,null);}catch(error){failure={error};}
  try{signer.closeCvmSession(session);}catch(error){failure??={error};}
  return failure;
}
/** Validate the public event independently; only its captured server selects the private native label. */
export function captureCvmEventCarrier(response:string):string{
  if(new TextEncoder().encode(response).length>40*1024)throw new CvmError('invalid message');
  const event=cvmRecord(JSON.parse(response),['type','server','message']);
  if(event.type!=='cvm.event')throw new CvmError('invalid message');
  const server=captureServer(event.server);captureMcp(event.message);
  return JSON.stringify({provider:server.pubkey,message:response});
}
/** Pure factory for actual module adapters and controlled bridge tests. No guest accepts this interface. */
export function createCvmNativePort(host:CvmHostModule,signer:CvmSignerModule,now:()=>number=Date.now,nonce:()=>string=()=>crypto.randomUUID()):CvmHostPort{
  return Object.freeze({
    take(token:string){const raw=host.takeCvmRequest(token);if(raw===null)return null;try{return captureCvmIngress(raw,token);}catch{host.rejectCvmRequest(token);return null;}},
    current:(generation:string,sourceRevision:string)=>host.isCvmSourceCurrent(generation,sourceRevision),approve:(token:string)=>host.approveCvmRequest(token),reject:(token:string)=>host.rejectCvmRequest(token),
    finish:(token:string,response:string|null)=>host.finishCvmRequest(token,response),event:(generation:string,sourceRevision:string,requestToken:string,response:string)=>host.sendCvmEvent(generation,sourceRevision,requestToken,captureCvmEventCarrier(response)),
    async open(permit:CvmPermit,signal:AbortSignal):Promise<CvmNativeSession>{
      if(signal.aborted)throw new CvmError('session closed');
      let id:string;try{id=opaque(await signer.openCvmSession(permit.token));}catch{throw new CvmError(signal.aborted?'session closed':'provider unavailable');}
      if(signal.aborted){revokeCvm(host,signer,id,permit.token);throw new CvmError('session closed');}
      const handlers=new Set<(value:CvmAuthenticated)=>void>(),closed=new Set<()=>void>();let ended=false;
      let offMessage={remove(){}},offClosed={remove(){}};
      offMessage=signer.addListener('onCvmMessage',value=>{
        if(ended||!value||typeof value!=='object'||(value as {session?:unknown}).session!==id)return;
        try{
          const row=cvmRecord(value,['session','message','eventId','references'],['paymentInteraction']);
          if(typeof row.message!=='string'||!Array.isArray(row.references)||row.references.length>16)throw new CvmError('invalid message');
          const message=captureMcp(JSON.parse(row.message)),eventId=hex(row.eventId),references=Object.freeze(row.references.map(hex));
          if(row.paymentInteraction!==undefined&&row.paymentInteraction!=='explicit_gating'&&row.paymentInteraction!=='transparent')throw new CvmError('invalid message');
          const captured=Object.freeze({message,eventId,references,...(row.paymentInteraction===undefined?{}:{paymentInteraction:row.paymentInteraction as 'explicit_gating'|'transparent'})});
          for(const handler of handlers)handler(captured);
        }catch{finish();signer.closeCvmSession(id);}
      });
      offClosed=signer.addListener('onCvmClosed',value=>{if(value&&typeof value==='object'&&(value as {session?:unknown}).session===id)finish();});
      function finish():void{if(ended)return;ended=true;offMessage.remove();offClosed.remove();for(const handler of closed)try{handler();}catch{/* Delivery is independent. */}handlers.clear();closed.clear();}
      if(ended){offMessage.remove();offClosed.remove();signer.closeCvmSession(id);throw new CvmError('session closed');}
      const port:CvmBytePort={
        async publish(next,purpose,message,replyTo,deadline,abort,prepared,acknowledged){
          if(ended||abort.aborted||now()>=deadline)throw new CvmError('session closed');
          const onAbort=()=>{finish();revokeCvm(host,signer,id,next.token);};abort.addEventListener('abort',onAbort,{once:true});
          try{
            const raw=await signer.prepareCvmMessage(id,next.token,purpose,JSON.stringify(message),replyTo);
            const plan=cvmRecord(JSON.parse(raw),['plan','innerEventId']);opaque(plan.plan);hex(plan.innerEventId);
            if(ended||abort.aborted||now()>=deadline)throw new CvmError('session closed');
            prepared(plan.innerEventId as string); // Installs exact reply identity before native commit can emit.
            await signer.commitCvmMessage(id,plan.plan as string);
            if(abort.aborted||now()>=deadline)throw new CvmError('session closed');acknowledged();
          }catch(error){onAbort();throw error instanceof CvmError?error:new CvmError('provider unavailable');}finally{abort.removeEventListener('abort',onAbort);}
        },
        onMessage(handler){if(ended)throw new CvmError('session closed');handlers.add(handler);return()=>{handlers.delete(handler);};},
        onClosed(handler){if(ended){handler();return()=>{};}closed.add(handler);return()=>{closed.delete(handler);};},
        async close(){finish();const failure=revokeCvm(host,signer,id,permit.token);if(failure)throw failure.error;},
      };
      const client=new CvmMcpClient(port,now,nonce);
      return Object.freeze({request:client.request.bind(client),onEvent:(handler:(message:unknown,ownerPermit?:string)=>void)=>client.onEvent(message=>handler(message,permit.token)),onClosed:client.onClosed.bind(client),close:client.close.bind(client)});
    },
  });
}
