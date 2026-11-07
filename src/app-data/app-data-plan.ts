import type {NostrEvent} from 'nostr-tools/pure';
import {claimsAppDataTemplate,captureAppDataTemplate,decodeAppDataRecord,selectLatestAppDataEvent,type AppDataRecord} from './app-data-contract.ts';
import {captureAppDataContext,assertCurrentAppDataSettings,type AppDataContext} from './app-data-context.ts';
import {decodeNativeRegistration,type NativeRegistration} from '../runtime/capability-protocol.ts';
import {routingRecord} from '../routing/routing-contract.ts';
import {parseOutboxPublish,assertOutboxEventFrameFits} from '../outbox/publication-contract.ts';
import type {OutboxPublicationPlan} from '../outbox/publication-plan.ts';
import {normalizeRelayUrl,type RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {parseQueryFilters,verifyQueryEvent,type QueryFilter} from '../network/relay-query-contract.ts';
import type {RelayQueryResult} from '../network/native-relay-query.ts';
import {captureEventSnapshot} from '../security/event-snapshot.ts';
import {validateSignedEvent,type VerifiedSignedEvent} from '../security/signed-event.ts';

export class AppDataPublicationError extends Error {
  constructor(code:string){super(code);this.name='AppDataPublicationError';}
}
export type AppDataPlan=Readonly<{route:'relay'|'outbox';requestId:string;record:AppDataRecord;context:AppDataContext;publication:OutboxPublicationPlan}>;
export type AppDataPlanningPort=Readonly<{
  settings():RelaySettingsSnapshot;
  query(filters:readonly QueryFilter[],relays:readonly string[],signal:AbortSignal,active:()=>void):Promise<RelayQueryResult>;
  publication(request:unknown,user:string,signal:AbortSignal,active:()=>void):Promise<OutboxPublicationPlan>;
}>;
type Held={readonly registration:NativeRegistration;readonly lock:string;readonly cacheKey:string;readonly cached:VerifiedSignedEvent|null;operations:number;released:boolean};
type Cached=Readonly<{sessionId:string;event:VerifiedSignedEvent}>;
// The selected account and addressable record serialize across all loaded source instances.
const recordLocks=new Set<string>();
function denied(code:string):never{throw new AppDataPublicationError(code);}
export function createAppDataPlanner(port:AppDataPlanningPort,now:()=>number=Date.now){
  const held=new WeakMap<AppDataPlan,Held>(),cache=new Map<string,Cached>();
  function state(plan:AppDataPlan):Held{const row=held.get(plan);return row&&!row.released?row:denied('app-data-cancelled');}
  function retire(plan:AppDataPlan,row:Held):void{if(row.released&&row.operations===0){held.delete(plan);recordLocks.delete(row.lock);}}
  function activeFor(registration:NativeRegistration,context:AppDataContext,signal:AbortSignal,active:()=>void):()=>void{
    return ()=>{active();if(signal.aborted)denied('app-data-cancelled');assertCurrentAppDataSettings(context,port.settings().networkRelays);
      if(registration.appData!==context)denied('app-data-cancelled');};
  }
  async function check(plan:AppDataPlan,row:Held,signal:AbortSignal,active:()=>void):Promise<void>{
    const checkActive=activeFor(row.registration,plan.context,signal,active);checkActive();
    const filters=parseQueryFilters([{kinds:[30078],authors:[row.registration.user],'#d':[plan.record.identifier],limit:1}]);
    const response=await port.query(filters,plan.publication.event.destinations,signal,checkActive);checkActive();
    if(response.incomplete)denied('app-data-read-incomplete');
    const events=response.events.map(item=>verifyQueryEvent(item.event,filters)) as NostrEvent[];
    const current=selectLatestAppDataEvent(events,row.registration.user,plan.record.identifier);
    if(current)decodeAppDataRecord(current);
    // One peer holding a cached event is insufficient: selection above includes every required peer.
    if(row.cached&&current?.id===row.cached.id)return;
    if((current?.id??null)!==plan.record.body.previous)denied('app-data-conflict');
    if(current&&plan.publication.event.event.created_at<=current.created_at)denied('app-data-invalid-time');
  }
  return Object.freeze({
    async plan(input:unknown,registrationInput:NativeRegistration,signal:AbortSignal,assertActive:()=>void):Promise<AppDataPlan>{
      const registration=decodeNativeRegistration(registrationInput);
      const request=routingRecord(input,['type','id','event'],['options']);
      const route=request.type==='outbox.publish'?'outbox':request.type==='relay.publish'?'relay':denied('app-data-invalid-request');
      if(!registration.appData||!registration.domains.includes(route)||!registration.domains.includes('identity'))denied('app-data-unavailable');
      if(route==='relay'&&Object.hasOwn(request,'options'))denied('app-data-invalid-request');
      if(typeof request.id!=='string'||!request.id.length||new TextEncoder().encode(request.id).byteLength>128)denied('app-data-invalid-request');
      if(!claimsAppDataTemplate(request.event))denied('app-data-invalid-request');
      const context=registration.appData;
      captureAppDataContext(context,registration);
      const active=activeFor(registration,context,signal,assertActive);active();
      const template=captureAppDataTemplate(request.event,registration.user,context.policy.scope);assertOutboxEventFrameFits(template,registration.user);
      const milliseconds=now(),seconds=Math.floor(milliseconds/1000);
      if(!Number.isSafeInteger(milliseconds)||milliseconds<0||template.created_at>seconds+60||template.created_at<seconds-86400)denied('app-data-invalid-time');
      const record=decodeAppDataRecord(template),lock=registration.user+':'+record.identifier;
      if(recordLocks.has(lock)||recordLocks.size>=16)denied('app-data-busy');recordLocks.add(lock);
      let transferred=false;
      try{
        let publication:OutboxPublicationPlan;
        if(route==='outbox'){
          const parsed=parseOutboxPublish(input,registration.user);
          const selected=await port.publication(parsed,registration.user,signal,active);active();
          publication=Object.freeze({...selected,ancillary:null});
        }else{
          const event=captureEventSnapshot(template,registration.user,context.policy.relays);
          publication=Object.freeze({requestId:request.id,event,destinations:Object.freeze(event.destinations.map(relay=>Object.freeze({relay,sources:Object.freeze([{kind:'network-fallback' as const}])}))),
            requiredInboxes:Object.freeze([]),ownSource:'network-fallback',ancillary:null});
        }
        active();
        const destinations=publication.event.destinations;
        if(destinations.length<1||destinations.length>8||destinations.some(peer=>!context.policy.relays.includes(normalizeRelayUrl(peer))))denied('app-data-relay-not-configured');
        const expected=captureEventSnapshot(template,registration.user,destinations);
        if(expected.hash!==publication.event.hash||publication.requestId!==request.id)denied('app-data-invalid-request');
        const cacheKey=JSON.stringify([registration,template,destinations]);
        const row:Held={registration,lock,cacheKey,cached:cache.get(cacheKey)?.event??null,operations:0,released:false};
        const plan=Object.freeze({route,requestId:request.id,record,context,publication});
        await check(plan,row,signal,active);active();held.set(plan,row);transferred=true;return plan;
      }finally{if(!transferred)recordLocks.delete(lock);}
    },
    async revalidate(plan:AppDataPlan,signal:AbortSignal,active:()=>void):Promise<void>{await check(plan,state(plan),signal,active);},
    assertCurrent(plan:AppDataPlan):void{state(plan);assertCurrentAppDataSettings(plan.context,port.settings().networkRelays);},
    cached(plan:AppDataPlan):VerifiedSignedEvent|null{return state(plan).cached;},
    signed(plan:AppDataPlan,event:VerifiedSignedEvent):void{
      const row=state(plan),captured=validateSignedEvent(plan.publication.event,event);
      if(cache.size>=16&&!cache.has(row.cacheKey))cache.delete(cache.keys().next().value!);
      cache.set(row.cacheKey,Object.freeze({sessionId:row.registration.sessionId,event:captured}));
    },
    retain(plan:AppDataPlan):()=>void{const row=state(plan);row.operations++;let returned=false;return()=>{if(!returned){returned=true;row.operations--;retire(plan,row);}};},
    release(plan:AppDataPlan):void{const row=held.get(plan);if(row){row.released=true;retire(plan,row);}},
    close(sessionId:string):void{for(const[key,row]of cache)if(row.sessionId===sessionId)cache.delete(key);},
  });
}
export type AppDataPlanner=ReturnType<typeof createAppDataPlanner>;

/** Product errors stay closed and never inspect a rejected value's prototype or getters. */
export function appDataFailure(error:unknown):string{
  const allowed=new Set(['app-data-invalid-id','app-data-invalid-json','app-data-too-complex','app-data-too-large','app-data-invalid-record','app-data-invalid-tags','app-data-scope-mismatch',
    'app-data-cancelled','app-data-invalid-request','app-data-unavailable','app-data-invalid-time','app-data-busy','app-data-relay-not-configured','app-data-read-incomplete','app-data-conflict','app-data-settings-changed']);
  try{if(error&&typeof error==='object'){const field=Object.getOwnPropertyDescriptor(error,'message');if(field&&'value'in field&&typeof field.value==='string'){if(field.value==='APPROVAL_DENIED')return'app-data-cancelled';if(allowed.has(field.value))return field.value;}}}catch{/* Unknown failures do not change cleanup or disclose raw errors. */}
  return'app-data-failed';
}
