import type {NostrEvent} from 'nostr-tools/pure';
import type {NativeRegistration} from '../runtime/capability-protocol.ts';
import {captureEventSnapshot} from '../security/event-snapshot.ts';
import {verifyQueryEvent,parseQueryFilters,type QueryFilter} from '../network/relay-query-contract.ts';
import type {RelayQueryResult} from '../network/native-relay-query.ts';
import {latestIdentityEvent} from '../identity/identity-contract.ts';
import {assertOutboxEventFrameFits} from '../outbox/publication-contract.ts';
import type {OutboxPublicationPlan} from '../outbox/publication-plan.ts';
import {parseCommonRequest,CommonError,type CommonSocialRequest} from './common-contract.ts';
import {COMMON_SOCIAL_PROFILE,deriveCommonSocial,validateCommonSocialIntent} from './social-template.ts';
export type CommonSocialPlan=Readonly<{request:CommonSocialRequest;route:'relay'|'outbox';basis:NostrEvent|null;
  target:NostrEvent|null;publication:OutboxPublicationPlan|null}>;
export type CommonSocialPlanner=ReturnType<typeof createCommonSocialPlanner>;
export type CommonPlanningPort=Readonly<{
  signer(user:string,active:()=>void):Promise<boolean>;
  query(filters:readonly QueryFilter[],registration:NativeRegistration,signal:AbortSignal,active:()=>void):Promise<RelayQueryResult>;
  publication(event:unknown,id:string,registration:NativeRegistration,signal:AbortSignal,active:()=>void):Promise<OutboxPublicationPlan>;
}>;
export function hasCommonSocial(registration:NativeRegistration):boolean{
  const d=registration.domains;
  return registration.fixture==='published'&&registration.commonProfile===COMMON_SOCIAL_PROFILE&&d.includes('common')&&d.includes('identity')&&(d.includes('relay')||d.includes('outbox'));
}
async function boundedSocial<T>(signal:AbortSignal,assertActive:()=>void,work:(signal:AbortSignal,active:()=>void)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),stop=()=>controller.abort();let closed=false;
  const active=()=>{assertActive();if(closed||signal.aborted||controller.signal.aborted)throw new CommonError('user-denied');};active();
  signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,15_000);
  let reject!:()=>void;const cancelled=new Promise<never>((_,fail)=>{reject=()=>fail(new CommonError('relay-timeout'));});
  controller.signal.addEventListener('abort',reject,{once:true});
  try{const result=await Promise.race([work(controller.signal,active),cancelled]);active();return result;}
  finally{closed=true;clearTimeout(timer);signal.removeEventListener('abort',stop);controller.signal.removeEventListener('abort',reject);controller.abort();}
}
async function createdAfter(basis:NostrEvent|null,now:()=>number,signal:AbortSignal,active:()=>void):Promise<number>{
  const read=()=>{active();const ms=now();if(!Number.isSafeInteger(ms)||ms<0)throw new CommonError('invalid-target');return ms;};
  const initial=read(),second=Math.floor(initial/1000);
  if(basis&&basis.created_at>second)throw new CommonError('follow-list-in-future');
  if(basis&&basis.created_at===second){
    await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new CommonError('user-denied'));};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},1000-initial%1000);signal.addEventListener('abort',stop,{once:true});});
    const next=Math.floor(read()/1000);if(next<=basis.created_at)throw new CommonError('follow-list-time-not-advanced');return next;
  }return second;
}
export function createCommonSocialPlanner(port:CommonPlanningPort,now:()=>number=Date.now){
  const owners=new Set<string>(),plans=new WeakMap<CommonSocialPlan,Readonly<{user:string;registration:NativeRegistration}>>();
  async function observed(filters:readonly QueryFilter[],registration:NativeRegistration,signal:AbortSignal,active:()=>void){
    active();const result=await port.query(filters,registration,signal,active);active();
    if(result.incomplete)throw new CommonError('relay-timeout');
    return latestIdentityEvent(result.events.map(row=>verifyQueryEvent(row.event,filters)));
  }
  const followFilters=(user:string)=>parseQueryFilters([{authors:[user],kinds:[3],limit:32}]);
  return Object.freeze({
    async plan(input:unknown,registration:NativeRegistration,signal:AbortSignal,active:()=>void):Promise<CommonSocialPlan>{
      if(!hasCommonSocial(registration))throw new CommonError();
      const parsed=parseCommonRequest(input);
      if(!['common.follow','common.unfollow','common.react','common.report'].includes(parsed.type))throw new CommonError();
      const request=parsed as CommonSocialRequest,user=registration.user;validateCommonSocialIntent(request);
      if(owners.has(user)||owners.size>=2)throw new CommonError('relay-timeout');
      owners.add(user);let retained=false;
      try{const prepared=await boundedSocial(signal,active,async(signal,active)=>{
        active();if(!await port.signer(user,active))throw new CommonError('not-signed-in');active();
        let basis:NostrEvent|null=null,target:NostrEvent|null=null;
        if(request.type==='common.follow'||request.type==='common.unfollow')basis=await observed(followFilters(user),registration,signal,active);
        else{
          const id=request.type==='common.react'?request.targetEventId:request.target.type==='event'?request.target.id:null;
          if(id!==null){if(!/^[0-9a-f]{64}$/.test(id))throw new CommonError('invalid-target');
            target=await observed(parseQueryFilters([{ids:[id],limit:1}]),registration,signal,active);
            if(!target)throw new CommonError('author-unresolved');}
        }
        active();const candidate=deriveCommonSocial(request,basis,target,0);
        const template=candidate?{...candidate,created_at:await createdAfter(basis,now,signal,active)}:null;
        if(template)try{assertOutboxEventFrameFits(template,user);}catch{throw new CommonError(request.type==='common.follow'||request.type==='common.unfollow'?'follow-list-too-large':'publication-too-large');}
        const publication=template===null?null:await port.publication(template,request.id,registration,signal,active);active();
        if(publication){const captured=captureEventSnapshot(template,user,publication.event.destinations);
          if(captured.hash!==publication.event.hash)throw new CommonError('invalid-target');}
        const plan=Object.freeze({request,route:registration.domains.includes('outbox')?'outbox' as const:'relay' as const,basis,target,publication});
        return plan;
      });plans.set(prepared,{user,registration});retained=true;return prepared;}finally{if(!retained)owners.delete(user);}
    },
    async revalidate(plan:CommonSocialPlan,signal:AbortSignal,active:()=>void):Promise<void>{
      const captured=plans.get(plan);if(!captured||!owners.has(captured.user))throw new CommonError('user-denied');
      await boundedSocial(signal,active,async(signal,active)=>{
      if(plan.request.type==='common.follow'||plan.request.type==='common.unfollow'){
        const latest=await observed(followFilters(captured.user),captured.registration,signal,active);
        if((latest?.id??null)!==(plan.basis?.id??null))throw new CommonError('follow-list-changed');
        const ms=now();if(!Number.isSafeInteger(ms)||ms<0||plan.publication&&plan.publication.event.event.created_at>Math.floor(ms/1000))throw new CommonError('follow-list-in-future');
      }active();
      });
    },
    release(plan:CommonSocialPlan):void{const captured=plans.get(plan);if(captured){plans.delete(plan);owners.delete(captured.user);}},
  });
}
