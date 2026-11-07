import {captureMcp,CvmError,CVM_LIMITS,CVM_OPERATIONS,mcpKey,parseCvmOperation,cvmFailure,type CvmRequest,
  type CvmServer,type McpMessage,type CvmOptions,type CvmObject,cvmCancellationKey} from './cvm-contract.ts';
export type CvmScope=Readonly<{endpoint:string;generation:string;sourceRevision:string;epoch:number;identity:string;publisher:string;appId:string;version:string;instance:string}>;
export type CvmReview=Readonly<{scope:CvmScope;requestId:string;server:CvmServer;message:McpMessage;options:CvmOptions;deadline:number}>;
/** An opaque host-issued review permit; never a key, guest credential or authority inferred from this type. */
export type CvmPermit=Readonly<{token:string}>;
export interface CvmNativeSession{
  request(permit:CvmPermit,message:McpMessage,deadline:number,signal:AbortSignal,options:CvmOptions):Promise<McpMessage|null>;
  onEvent(handler:(message:unknown,ownerPermit?:string)=>void):()=>void;
  onClosed(handler:(reason?:CvmError,completedPermits?:ReadonlySet<string>)=>void):()=>void;
  /** Logical revocation ACK only; native capacity is retained separately until actual resource drain. */
  close():Promise<void>;
}
export interface CvmPorts{
  now():number;
  assertCurrent(scope:CvmScope):void;
  review(input:CvmReview,signal:AbortSignal):Promise<CvmPermit>;
  open(input:CvmReview,permit:CvmPermit,signal:AbortSignal):Promise<CvmNativeSession>;
}
type Session={native:CvmNativeSession;used:Set<string>;tokens:Set<string>;incoming:Set<string>;server:CvmServer;off:()=>void};
type Work={requestKey:string|null;cancelTarget:Work|null;server:string;revision:number;controller:AbortController;deadline:number;reason:CvmError|null;full:boolean;token:string|null;permit:string|null;dispatched:boolean;session:Session|null;options:CvmOptions};
const isRequest=(message:McpMessage)=>message.method!==undefined&&message.id!==undefined;
/** Native still owns actual worker/key/socket reservations until real unwind. This map is logical ownership only. */
export class CvmEndpoint{
  private current=true;
  private readonly sessions=new Map<string,Session>();
  private readonly revisions=new Map<string,number>();
  private readonly work=new Set<Work>();
  private readonly handlers=new Set<(event:Readonly<{server:CvmServer;message:McpMessage;ownerPermit?:string}>)=>void>();
  private active=0;
  private side=0;
  private readonly scope:CvmScope;
  private readonly ports:CvmPorts;
  constructor(scope:CvmScope,ports:CvmPorts){this.scope=Object.freeze({...scope});this.ports=ports;}
  onEvent(handler:(event:Readonly<{server:CvmServer;message:McpMessage;ownerPermit?:string}>)=>void):()=>void{
    this.check();
    this.handlers.add(handler);return()=>{this.handlers.delete(handler);};
  }
  private check(work?:Work):void{
    if(!this.current||work&&(work.reason||!this.work.has(work)||work.controller.signal.aborted||this.revisions.get(work.server)!==work.revision))throw work?.reason??new CvmError('session closed');
    this.ports.assertCurrent(this.scope);
    if(work&&this.ports.now()>=work.deadline)throw new CvmError('relay timeout');
  }
  async dispatch(value:unknown,nativeDeadline?:number):Promise<Readonly<Record<string,unknown>>|null>{
    let type='cvm.request',id='';
    if(!value||typeof value!=='object')return null;
    const kind=Object.getOwnPropertyDescriptor(value,'type');
    if(!kind||!('value' in kind)||!CVM_OPERATIONS.includes(kind.value))return null;
    try{
      const request=parseCvmOperation(value);type=request.type;id=request.id;this.check();
      if(request.type==='cvm.close'){await this.close(request.server);return Object.freeze({type:type+'.result',id});}
      if(request.type==='cvm.registry.has')return Object.freeze({type:type+'.result',id,has:false});
      if(request.type!=='cvm.request')throw new CvmError('unsupported method');
      const message=await this.execute(request,nativeDeadline);
      return Object.freeze({type:type+'.result',id,...(message===null?{}:{message})});
    }catch(error){
      if(value&&typeof value==='object'){
        const descriptors=Object.getOwnPropertyDescriptors(value);
        if(typeof descriptors.type?.value==='string'&&descriptors.type.value.startsWith('cvm.'))type=descriptors.type.value;
        if(typeof descriptors.id?.value==='string')id=descriptors.id.value;
      }
      return cvmFailure(type,id,error);
    }
  }
  private execute(request:CvmRequest,nativeDeadline?:number):Promise<McpMessage|null>{
    this.check();const full=isRequest(request.message),cancelTarget=this.cancellationTarget(request);
    if(full?this.active>=CVM_LIMITS.requestsPerEndpoint:this.side>=1||this.active>0&&!this.sessions.has(request.server.pubkey))throw new CvmError('policy denied');
    const meta=request.message.params?._meta;
    const rawToken=meta&&typeof meta==='object'&&!Array.isArray(meta)?(meta as CvmObject).progressToken:undefined;
    const token=typeof rawToken==='string'||typeof rawToken==='number'?mcpKey(rawToken):null;
    const revision=this.revisions.get(request.server.pubkey)??0;this.revisions.set(request.server.pubkey,revision);
    const now=this.ports.now();
    if(nativeDeadline!==undefined&&(!Number.isFinite(nativeDeadline)||nativeDeadline<=now))throw new CvmError('relay timeout');
    const work:Work={requestKey:full?mcpKey(request.message.id!):null,cancelTarget,server:request.server.pubkey,revision,controller:new AbortController(),deadline:Math.min(now+request.options.timeoutMs,nativeDeadline??Infinity),reason:null,full,token,permit:null,dispatched:false,session:null,options:request.options};
    const review=Object.freeze({scope:this.scope,requestId:request.id,server:request.server,message:request.message,options:request.options,deadline:work.deadline});
    this.work.add(work);if(full)this.active++;else this.side++;
    let expire!:(error:CvmError)=>void;
    const expiry=new Promise<never>((_,reject)=>{expire=reject;});
    const abort=()=>{expire(work.reason??new CvmError('session closed'));};
    work.controller.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{work.reason=new CvmError('relay timeout');work.controller.abort();},Math.max(0,work.deadline-this.ports.now()));
    return Promise.race([this.run(request,review,work),expiry]).finally(()=>{
      clearTimeout(timer);work.controller.signal.removeEventListener('abort',abort);this.work.delete(work);if(!this.sessions.has(work.server)&&![...this.work].some(row=>row.server===work.server))this.revisions.delete(work.server);if(full)this.active--;else this.side--;
    });
  }
  private cancellationTarget(request:CvmRequest):Work|null{
    const key=cvmCancellationKey(request.message);if(key===null)return null;
    for(const target of this.work)if(target.full&&target.requestKey===key&&target.server===request.server.pubkey&&
      target.dispatched&&!target.controller.signal.aborted&&this.ports.now()<target.deadline&&target.session===this.sessions.get(request.server.pubkey))return target;
    throw new CvmError('invalid message');
  }
  private recheckCancellation(request:CvmRequest,work:Work):void{
    if(work.cancelTarget&&this.cancellationTarget(request)!==work.cancelTarget)throw new CvmError('invalid message');
  }
  private async session(review:CvmReview,permit:CvmPermit,work:Work):Promise<Session>{
    const existing=this.sessions.get(review.server.pubkey);
    if(existing)return existing;
    if(this.sessions.size>=CVM_LIMITS.endpoints)throw new CvmError('policy denied');
    const native=await this.ports.open(review,permit,work.controller.signal);
    try{this.check(work);}catch(error){void this.retire(native).catch(()=>{});throw error;}
    const session:Session={native,used:new Set(),tokens:new Set(),incoming:new Set(),server:review.server,off:()=>undefined};
    this.sessions.set(review.server.pubkey,session);
    let offEvent:()=>void=()=>undefined,offClosed:()=>void=()=>undefined;
    try{
      offEvent=native.onEvent((raw,ownerPermit)=>this.event(session,raw,ownerPermit));
      offClosed=native.onClosed((reason,completed)=>this.nativeClosed(session,reason,completed));
    }catch(error){
      if(this.sessions.get(review.server.pubkey)===session)this.sessions.delete(review.server.pubkey);
      try{offEvent();}catch{/* Native close remains mandatory when subscription cleanup fails. */}
      void this.retire(native).catch(()=>{});throw error;
    }
    session.off=()=>{try{offEvent();}finally{offClosed();}};
    if(this.sessions.get(review.server.pubkey)!==session){session.off();throw new CvmError('provider unavailable');}
    return session;
  }
  private nativeClosed(session:Session,reason?:CvmError,completed?:ReadonlySet<string>):void{
    if(this.sessions.get(session.server.pubkey)!==session)return;
    this.sessions.delete(session.server.pubkey);this.unsubscribe(session);
    for(const work of this.work)if(work.session===session&&work.dispatched&&(!work.permit||!completed?.has(work.permit))){work.reason=reason??new CvmError('session closed');work.controller.abort();}
  }
  private async run(request:CvmRequest,review:CvmReview,work:Work):Promise<McpMessage|null>{
    const prior=this.sessions.get(request.server.pubkey),key=isRequest(request.message)?mcpKey(request.message.id!):null;
    if(key&&prior?.used.has(key))throw new CvmError('invalid message');
    if(request.message.method===undefined&&!prior?.incoming.has(mcpKey(request.message.id!)))throw new CvmError('invalid message');
    this.check(work);const permit=await this.ports.review(review,work.controller.signal);this.check(work);this.recheckCancellation(request,work);work.permit=permit.token;
    const session=await this.session(review,permit,work);this.check(work);
    if(this.sessions.get(request.server.pubkey)!==session)throw new CvmError('provider unavailable');
    if(key){if(session.used.has(key)||session.used.size>=1024)throw new CvmError('invalid message');session.used.add(key);}
    if(request.message.method===undefined){
      const inbound=mcpKey(request.message.id!);
      if(!session.incoming.delete(inbound))throw new CvmError('invalid message');
    }
    if(work.token){if(session.tokens.has(work.token)||session.tokens.size>=1024)throw new CvmError('invalid message');session.tokens.add(work.token);}
    this.recheckCancellation(request,work);work.session=session;work.dispatched=true;
    const message=await session.native.request(permit,request.message,work.deadline,work.controller.signal,request.options);
    this.check(work);
    if(request.message.method===undefined||request.message.id===undefined){if(message!==null)throw new CvmError('invalid message');return null;}
    if(message===null)throw new CvmError('invalid message');
    const captured=captureMcp(message);
    if(captured.id!==request.message.id||captured.method!==undefined)throw new CvmError('invalid message');
    if(captured.error?.code===-32042)throw this.paymentFailure(request.options);
    return captured;
  }
  private event(session:Session,raw:unknown,ownerPermit?:string):void{
    try{
      this.check();if(this.sessions.get(session.server.pubkey)!==session)return;
      const message=captureMcp(raw);
      if(message.method===undefined)return; // Final/late responses are never notifications.
      if(message.method==='notifications/payment_required'){
        for(const work of this.work)if(work.server===session.server.pubkey&&work.full&&work.dispatched){work.reason=this.paymentFailure(work.options);work.controller.abort();}
        return;
      }
      if(message.method==='notifications/cancelled'&&!session.incoming.delete(cvmCancellationKey(message)!))return;
      if(message.method==='notifications/progress'){
        const token=message.params?.progressToken;
        if(typeof token!=='string'&&typeof token!=='number')throw new CvmError('invalid message');
        const owned=[...this.work].some(work=>work.server===session.server.pubkey&&work.token===mcpKey(token)&&work.dispatched&&!work.controller.signal.aborted&&this.ports.now()<work.deadline);
        if(!owned)return;
      }
      if(message.id!==undefined){
        const key=mcpKey(message.id);if(session.incoming.has(key)||session.incoming.size>=32)throw new CvmError('invalid message');session.incoming.add(key);
      }
      const item=Object.freeze({server:session.server,message,...(ownerPermit===undefined?{}:{ownerPermit})});
      for(const handler of this.handlers){this.check();try{handler(item);}catch{/* A listener cannot suppress native bookkeeping. */}}
    }catch{
      void this.close(session.server).catch(()=>{});
    }
  }
  private paymentFailure(options:CvmOptions):CvmError{
    return new CvmError(options.payment==='prompt'?'payment required':'payment denied');
  }
  private unsubscribe(session:Session):void{try{session.off();}catch{/* Map removal already fences delivery; actual native close is independent. */}}
  private async retire(native:CvmNativeSession):Promise<void>{await native.close();}
  async close(server:CvmServer):Promise<void>{
    if(this.sessions.has(server.pubkey)||[...this.work].some(row=>row.server===server.pubkey))this.revisions.set(server.pubkey,(this.revisions.get(server.pubkey)??0)+1);
    for(const work of this.work)if(work.server===server.pubkey){work.reason=new CvmError('session closed');work.controller.abort();}
    const session=this.sessions.get(server.pubkey);this.sessions.delete(server.pubkey);
    if(session){this.unsubscribe(session);await this.retire(session.native);}
    if(![...this.work].some(row=>row.server===server.pubkey))this.revisions.delete(server.pubkey);
  }
  revoke():void{
    this.current=false;
    for(const work of this.work){work.reason=new CvmError('session closed');work.controller.abort();}
    for(const session of this.sessions.values()){this.unsubscribe(session);void this.retire(session.native).catch(()=>{});}
    this.sessions.clear();this.handlers.clear();
  }
}
