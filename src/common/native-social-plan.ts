import type {RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {createNativeRelayQuery} from '../network/native-relay-query.ts';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay.ts';
import type {OutboxAuthorResolver} from '../outbox/author-resolver.ts';
import {resolveOutboxPlan} from '../outbox/route-plan.ts';
import type {OutboxPublicationPlanner} from '../outbox/approval-preparation.ts';
import {captureEventSnapshot} from '../security/event-snapshot.ts';
import {createCommonSocialPlanner} from './social-plan.ts';
/** Native admission binds the fixed intent; app-owned preparation never exposes a generic read/write API. */
export function createNativeCommonSocialPlanner(native:NativePublishedRelayPort,resolver:OutboxAuthorResolver,
  settings:()=>RelaySettingsSnapshot,publication:OutboxPublicationPlanner,signer:(user:string,active:()=>void)=>Promise<boolean>){
  return createCommonSocialPlanner({
    signer,
    async query(filters,registration,signal,active){
      const trusted=settings();let relays=trusted.networkRelays;
      if(registration.domains.includes('outbox')){
        const authors=[...new Set(filters.flatMap(filter=>(filter.authors??[]) as readonly string[]))];
        const plan=await resolveOutboxPlan(resolver,trusted,registration.user,authors,[],'read',signal,active,false,{wide:false,timeoutMs:7500});
        if(plan.incomplete)throw new Error('Incomplete follow/target routing');relays=[...plan.relays];
      }
      active();return createNativeRelayQuery(native,()=>relays).queryDetailed(filters,signal,active,{timeoutMs:7500});
    },
    async publication(template,id,registration,signal,active){
      if(registration.domains.includes('outbox')){const plan=await publication.plan({type:'outbox.publish',id,event:template,options:{toOutbox:true}},registration.user,signal,active);active();return Object.freeze({...plan,ancillary:null});}
      active();const event=captureEventSnapshot(template,registration.user,settings().networkRelays);
      return Object.freeze({requestId:id,event,destinations:Object.freeze(event.destinations.map(relay=>Object.freeze({relay,sources:Object.freeze([{kind:'network-fallback' as const}])}))),requiredInboxes:Object.freeze([]),ownSource:'network-fallback' as const,ancillary:null});
    },
  });
}
