import {captureEventSnapshot, type EventSnapshot} from '../security/event-snapshot.ts';
import {validateSignedEvent, type VerifiedSignedEvent} from '../security/signed-event.ts';
import {normalizeRelayUrl, type RelaySettingsSnapshot} from '../network/relay-settings.ts';
import {QUERY_LIMITS} from '../network/relay-query-contract.ts';
import {publicKey} from '../storage/codec.ts';
import type {OutboxAuthorResolution, OutboxAuthorResolver} from './author-resolver.ts';
import {OUTBOX_LIST_LIMITS, parseOutboxRelayList} from './relay-list.ts';
import {assertOutboxEventFrameFits, OutboxPublicationError, parseOutboxPublish, type OutboxPublishRequest} from './publication-contract.ts';

export type OutboxDestinationSource=Readonly<{kind:'own'|'network-fallback'|'inbox'|'explicit';author?:string}>;
export type OutboxPublicationPlan=Readonly<{requestId:string;event:EventSnapshot;
  destinations:readonly Readonly<{relay:string;sources:readonly OutboxDestinationSource[]}>[];
  requiredInboxes:readonly string[];ownSource:'nip65'|'network-fallback'|'skipped';ancillary:VerifiedSignedEvent|null}>;
/** App-only policy is selected by the shell; D-09 selects omit when own routing is skipped. */
export type OutboxPublicationPolicy=Readonly<{ancillaryWhenOutboxSkipped:'lookup'|'omit'}>;
function assemble(request:OutboxPublishRequest,user:string,network:readonly string[],results:ReadonlyMap<string,OutboxAuthorResolution|null>,includeAncillary:boolean):OutboxPublicationPlan {
  const union=new Map<string,OutboxDestinationSource[]>(),required=new Set<string>();
  function add(relays:readonly string[],source:OutboxDestinationSource):void {
    for(const input of relays){const relay=normalizeRelayUrl(input),sources=union.get(relay)??[];
      if(!sources.some(row=>row.kind===source.kind&&row.author===source.author))sources.push(Object.freeze({...source}));
      union.set(relay,sources);if(source.kind==='inbox')required.add(relay);}
    if(union.size>OUTBOX_LIST_LIMITS.relays)throw new OutboxPublicationError('policy denied');
  }
  const own=results.get(user),ownList=own&&!own.incomplete&&own.list ? parseOutboxRelayList(own.list.event,user) : null;
  let ownSource:OutboxPublicationPlan['ownSource']='skipped';
  if(request.options.toOutbox){
    if(ownList?.write.length){add(ownList.write,{kind:'own',author:user});ownSource='nip65';}
    else {if(!network.length)throw new OutboxPublicationError('own fallback unavailable');add(network,{kind:'network-fallback',author:user});ownSource='network-fallback';}
  }
  for(const author of request.options.toInboxes){const result=results.get(author);
    if(!result || result.incomplete || !result.list)throw new OutboxPublicationError('required inbox unavailable');
    const list=parseOutboxRelayList(result.list.event,author);
    if(!list.read.length)throw new OutboxPublicationError('required inbox unavailable');
    add(list.read,{kind:'inbox',author});
  }
  add(request.options.relays,{kind:'explicit'});
  if(!union.size)throw new OutboxPublicationError('no publication destinations');
  const event=captureEventSnapshot(request.event,user,[...union.keys()]);
  const destinations=Object.freeze([...union.entries()].map(([,sources],index)=>Object.freeze({relay:event.destinations[index]!,sources:Object.freeze(sources)})));
  const requiredInboxes=Object.freeze([...union.keys()].flatMap((relay,index)=>required.has(relay)?[event.destinations[index]!]:[]));
  const ancillary=includeAncillary&&ownList ? validateSignedEvent(captureEventSnapshot({kind:ownList.event.kind,content:ownList.event.content,tags:ownList.event.tags,created_at:ownList.event.created_at},user,event.destinations),ownList.event) : null;
  if(ancillary)assertOutboxEventFrameFits(ancillary,user);
  return Object.freeze({requestId:request.id,event,destinations,requiredInboxes,ownSource,ancillary});
}
/** Resolution captures the event/settings before await and has no signer, send or guest admission path. */
export function createOutboxPublicationPlanner(resolver:OutboxAuthorResolver,settings:()=>RelaySettingsSnapshot,
  policy:OutboxPublicationPolicy,timeoutMs:number=QUERY_LIMITS.timeoutMs) {
  if(!['lookup','omit'].includes(policy.ancillaryWhenOutboxSkipped)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>QUERY_LIMITS.timeoutMs)throw new OutboxPublicationError();
  const ancillaryWhenSkipped=policy.ancillaryWhenOutboxSkipped;let pending=0;
  return Object.freeze({async plan(input:unknown,userInput:string,signal:AbortSignal,assertActive:()=>void):Promise<OutboxPublicationPlan>{
    const user=publicKey(userInput),request=parseOutboxPublish(input,user);
    if(pending>=QUERY_LIMITS.concurrent)throw new OutboxPublicationError('publication resolution busy');
    const controller=new AbortController(),stop=()=>controller.abort();
    const active=()=>{assertActive();if(signal.aborted||controller.signal.aborted)throw new OutboxPublicationError('publication resolution cancelled');};
    active();const trusted=settings(),network=Object.freeze(trusted.networkRelays.map(normalizeRelayUrl));
    if(network.length>OUTBOX_LIST_LIMITS.relays||new Set(network).size!==network.length)throw new OutboxPublicationError('policy denied');
    pending++;signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,timeoutMs);
    let rejectCancelled!:()=>void;const cancelled=new Promise<never>((_,reject)=>{rejectCancelled=()=>reject(new OutboxPublicationError('publication resolution cancelled'));});
    controller.signal.addEventListener('abort',rejectCancelled,{once:true});
    async function resolve():Promise<OutboxPublicationPlan>{
      const authors=[...new Set([...(request.options.toOutbox||ancillaryWhenSkipped==='lookup'?[user]:[]),...request.options.toInboxes])];
      const results=new Map<string,OutboxAuthorResolution|null>();
      async function worker(index:number):Promise<void>{
        if(index>=authors.length)return;active();const author=authors[index]!;
        try {results.set(author,await resolver.resolve(user,author,'publication',controller.signal,active));}
        catch {active();results.set(author,null);}
        active();return worker(index+2);
      }
      await Promise.all([worker(0),worker(1)]);active();const plan=assemble(request,user,network,results,request.options.toOutbox||ancillaryWhenSkipped==='lookup');active();return plan;
    }
    try {const plan=await Promise.race([resolve(),cancelled]);active();return plan;}
    finally {clearTimeout(timer);signal.removeEventListener('abort',stop);controller.signal.removeEventListener('abort',rejectCancelled);controller.abort();pending--;}
  }});
}
