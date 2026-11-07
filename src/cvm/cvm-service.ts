import {CvmEndpoint,type CvmNativeSession,type CvmPermit,type CvmReview,type CvmScope} from './cvm-session.ts';
import {captureMcp,CvmError,parseCvmOperation,cvmMetadata,type CvmOptions,type CvmServer} from './cvm-contract.ts';
export type CvmIngress=Readonly<{token:string;scope:CvmScope;requestId:string;server:CvmServer;message:string;operation:string;progressTokenJSON:string|null;options:CvmOptions;remainingMs:number}>;
export type CvmReviewItem=Readonly<{id:string;origin:Readonly<{sessionId:string;generation:string;epoch:number}>;review:CvmReview}>;
export interface CvmHostPort{
  take(token:string):CvmIngress|null;
  current(generation:string,sourceRevision:string):boolean;
  approve(token:string):string|null;
  reject(token:string):void;
  finish(token:string,response:string|null):void;
  event(generation:string,sourceRevision:string,requestToken:string,response:string):boolean;
  open(permit:CvmPermit,signal:AbortSignal):Promise<CvmNativeSession>;
}
/** Complete every logical/native revocation attempt, then preserve the first failure as an unknown outcome. */
function cleanupCvm(actions:readonly (()=>void)[]):void{
  let failed=false,first:unknown;
  for(const action of actions)try{action();}catch(error){if(!failed){failed=true;first=error;}}
  if(failed)throw first;
}
type Pending={item:CvmReviewItem;signal:AbortSignal;resolve:(permit:CvmPermit)=>void;reject:(error:CvmError)=>void;abort:()=>void;onAbort:()=>void};
/** Native first-ingress deadlines, source bindings and one-use permits remain authoritative. */
export class CvmService{
  private readonly endpoints=new Map<string,{scope:CvmScope;endpoint:CvmEndpoint;off:()=>void}>();
  private readonly permits=new Map<string,string>();
  private readonly ingress=new Map<string,CvmIngress>();
  private readonly pending=new Map<string,Pending>();
  private readonly listeners=new Set<()=>void>();
  private closed=false;
  private readonly host:CvmHostPort;
  private readonly now:()=>number;
  constructor(host:CvmHostPort,now:()=>number=Date.now){this.host=host;this.now=now;}
  private snapshot:Readonly<{current:CvmReviewItem|null;pendingSessionIds:readonly string[]}>=Object.freeze({current:null,pendingSessionIds:Object.freeze([])});
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private notify():void{this.snapshot=Object.freeze({current:this.pending.values().next().value?.item??null,
    pendingSessionIds:Object.freeze([...new Set([...this.ingress.values()].map(row=>row.scope.endpoint))])});for(const listener of this.listeners)try{listener();}catch{/* Presentation cannot authorize a request. */}}
  private check(scope:CvmScope):void{
    const row=this.endpoints.get(scope.generation);
    if(this.closed||!row||JSON.stringify(row.scope)!==JSON.stringify(scope)||!this.host.current(scope.generation,scope.sourceRevision))throw new CvmError('session closed');
  }
  async receive(token:string):Promise<void>{
    if(this.closed||this.ingress.has(token))return;
    const input=this.host.take(token);if(!input)return;
    if(!Number.isFinite(input.remainingMs)||input.remainingMs<=0||input.remainingMs>120000){this.host.reject(token);return;}
    const captured=Object.freeze({...input,scope:Object.freeze({...input.scope})});
    let prior=this.endpoints.get(captured.scope.generation);
    if(prior&&!this.host.current(prior.scope.generation,prior.scope.sourceRevision)){prior.endpoint.revoke();prior.off();this.endpoints.delete(captured.scope.generation);prior=undefined;}
    if(prior&&JSON.stringify(prior.scope)!==JSON.stringify(captured.scope)){this.host.reject(token);return;}
    this.ingress.set(token,captured);
    const deadline=this.now()+input.remainingMs;
    let response:string|null=null;
    try{
      const request=parseCvmOperation({type:'cvm.request',id:captured.requestId,server:captured.server,message:captureMcp(JSON.parse(captured.message)),options:captured.options});
      if(request.type!=='cvm.request')throw new CvmError('invalid request');
      const metadata=cvmMetadata(request.message);if(metadata.operation!==captured.operation||metadata.progressTokenJSON!==captured.progressTokenJSON)throw new CvmError('invalid request');
      const endpoint=prior?.endpoint??this.create(captured.scope);
      response=JSON.stringify(await endpoint.dispatch(request,deadline));
    }catch(error){response=JSON.stringify({type:'cvm.request.result',id:captured.requestId,error:error instanceof CvmError?error.message:'policy denied'});}
    finally{
      cleanupCvm([
        ()=>this.pending.get(token)?.abort(),
        ()=>{this.ingress.delete(token);for(const [permit,request] of this.permits)if(request===token)this.permits.delete(permit);},
        ()=>this.host.finish(token,response),()=>this.notify(),
      ]);
    }
  }
  private create(scope:CvmScope):CvmEndpoint{
    const endpoint=new CvmEndpoint(scope,{now:this.now,assertCurrent:()=>this.check(scope),
      review:(review,signal)=>this.review(review,signal),open:(_review,permit,signal)=>this.host.open(permit,signal)});
    const row={scope,endpoint,off:()=>{}};this.endpoints.set(scope.generation,row);
    row.off=endpoint.onEvent(event=>{
      try{
        this.check(scope);const request=event.ownerPermit?this.permits.get(event.ownerPermit):undefined;
        if(!request||!this.host.event(scope.generation,scope.sourceRevision,request,JSON.stringify({type:'cvm.event',server:event.server,message:event.message})))this.close(scope.endpoint);
      }catch{this.close(scope.endpoint);}
    });return endpoint;
  }
  private review(review:CvmReview,signal:AbortSignal):Promise<CvmPermit>{
    this.check(review.scope);
    const matches=[...this.ingress.values()].filter(row=>row.scope.generation===review.scope.generation&&row.requestId===review.requestId);
    if(matches.length!==1||signal.aborted)throw new CvmError('session closed');
    const row=matches[0];if(this.pending.has(row.token))throw new CvmError('policy denied');
    return new Promise((resolve,reject)=>{
      const abort=()=>{if(this.pending.get(row.token)?.abort!==abort)return;this.pending.delete(row.token);signal.removeEventListener('abort',onAbort);try{this.host.reject(row.token);}finally{reject(new CvmError('session closed'));this.notify();}};
      const onAbort=()=>{try{abort();}catch{/* receive.finally still attempts native finish; a signal callback must not throw asynchronously. */}};
      const item=Object.freeze({id:row.token,origin:Object.freeze({sessionId:row.scope.endpoint,generation:row.scope.generation,epoch:row.scope.epoch}),review});
      this.pending.set(row.token,{item,signal,resolve,reject,abort,onAbort});signal.addEventListener('abort',onAbort,{once:true});this.notify();
      if(signal.aborted)onAbort();
    });
  }
  decide(token:string,approved:boolean):void{
    const pending=this.pending.get(token);if(!pending||this.pending.values().next().value!==pending)return;
    if(pending.signal.aborted){pending.abort();return;}
    try{
      this.check(pending.item.review.scope);
      const permit=approved?this.host.approve(token):null;
      if(!permit){pending.abort();return;}
      if(this.permits.has(permit))throw new CvmError('policy denied');this.permits.set(permit,token);
      this.pending.delete(token);pending.signal.removeEventListener('abort',pending.onAbort);pending.resolve(Object.freeze({token:permit}));this.notify();
    }catch{pending.abort();}
  }
  close(sessionId:string):void{
    const ingress=[...this.ingress.values()].filter(row=>row.scope.endpoint===sessionId);
    const endpoints=[...this.endpoints].filter(([,row])=>row.scope.endpoint===sessionId);
    const pending=[...this.pending.values()].filter(row=>row.item.origin.sessionId===sessionId);
    cleanupCvm([
      ...ingress.map(row=>()=>this.host.finish(row.token,null)),
      ...endpoints.flatMap(([generation,row])=>[()=>row.endpoint.revoke(),()=>row.off(),()=>{this.endpoints.delete(generation);}]),
      ...pending.map(row=>()=>row.abort()),()=>this.notify(),
    ]);
  }
  pause():void{cleanupCvm([...this.endpoints.values()].map(row=>()=>this.close(row.scope.endpoint)));}
  dispose():void{if(this.closed)return;this.closed=true;cleanupCvm([()=>this.pause(),()=>this.listeners.clear()]);}
}
