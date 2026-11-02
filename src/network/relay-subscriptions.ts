import { OUTBOX_LIST_LIMITS } from '../outbox/relay-list.ts';
import { parsePublishedRelayMessage } from '../napplets/published-relay-wire.ts';
import { normalizeRelayUrl, MAX_RELAYS_PER_ROLE } from './relay-settings.ts';
import { verifyQueryEvent } from './relay-query-contract.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { decodeNativeRegistration, type NativeRegistration } from '../runtime/capability-protocol.ts';
import { parseRelaySubscribe, parseRelayClose, RelaySubscriptionError, SUBSCRIPTION_LIMITS,
  type RelaySubscribeRequest, type RelaySubscriptionMessage } from './relay-subscription-contract.ts';

/** Process-owned native socket adapter. Never supplied to guest code or WebView props. */
export interface NativeRelayStreamPort {
  newInstanceId():string;
  open(operationId:string,url:string,request:string,subscriptionId:string,
    frame:(text:string)=>void,failed:()=>void,authorityToken?:string):()=>void;
}
export interface RelaySubscriptionOwner {readonly registration:NativeRegistration;assertActive():void;}
type Emit=(message:RelaySubscriptionMessage)=>boolean|'paused';
type Connection={id:string;sub:string;relay:string;stop:(()=>void)|null;retry:ReturnType<typeof setTimeout>|null;
  revision:number;attempts:number;state:'opening'|'eose'|'failed';windowStart:number;frames:number};
type Subscription={request:RelaySubscribeRequest;emit:Emit;connections:Connection[];ids:Set<string>;ended:boolean;eose:boolean;epoch:number;authorityToken:string|undefined;planned:boolean;backfillLimit:number;backfill:number;initialTimeoutMs:number;initialTimer:ReturnType<typeof setTimeout>|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SessionProcess={foreground:boolean;total:number;port:NativeRelayStreamPort;newId:()=>string;
  destinations:()=>readonly string[];now:()=>number;retryMs:readonly number[];
  sessions:Map<string,{pause:()=>void;resume:()=>void;revoke:()=>void}>};
type SessionCallbacks={active:()=>void;emit:(subscription:Subscription,message:RelaySubscriptionMessage)=>boolean;eose:(subscription:Subscription)=>void};
function receiveFrame(process:SessionProcess,callbacks:SessionCallbacks,subscription:Subscription,connection:Connection,text:string):void {
  callbacks.active();
  const clock=process.now();if(!Number.isFinite(clock)||clock<connection.windowStart)throw new RelaySubscriptionError();
  if(clock-connection.windowStart>=1000){connection.frames=0;connection.windowStart=clock;}
  if(++connection.frames>SUBSCRIPTION_LIMITS.framesPerSecond||typeof text!=='string'||utf8Bytes(text)>66*1024)throw new RelaySubscriptionError('relay stream limit');
  const message=parsePublishedRelayMessage(text,connection.sub);
  if(message.type==='event') {
    const filters=subscription.planned?subscription.request.filters.map(filter=>({...filter,limit:32})):subscription.request.filters;
    const event=verifyQueryEvent(message.event,filters);
    if(event.kind===4||event.kind===1059)throw new RelaySubscriptionError('encrypted subscriptions unsupported');
    if(subscription.ids.has(event.id))return;
    if(subscription.planned&&connection.state!=='eose'&&subscription.backfill>=subscription.backfillLimit)return;
    subscription.ids.add(event.id);
    if(subscription.ids.size>SUBSCRIPTION_LIMITS.dedupe)subscription.ids.delete(subscription.ids.values().next().value!);
    if(subscription.planned&&connection.state!=='eose')subscription.backfill++;
    if(!callbacks.emit(subscription,Object.freeze({type:'relay.event',subId:subscription.request.subId,result:Object.freeze({event,...(subscription.planned?{sidecar:Object.freeze({relayHints:Object.freeze([connection.relay])})}:{})})})))subscription.ids.delete(event.id);
  }else if(message.type==='eose'){connection.state='eose';connection.attempts=0;callbacks.eose(subscription);}
  else if(message.type!=='notice'&&message.type!=='auth')throw new RelaySubscriptionError();
}
function createSession(owner:RelaySubscriptionOwner,registration:NativeRegistration,process:SessionProcess) {
  const {port,newId,now,retryMs,sessions}=process;
      let revoked=false;
      const subscriptions=new Map<string,Subscription>(),callerIds=new Set<string>();
      const active=()=>{if(revoked)throw new RelaySubscriptionError('relay owner revoked');owner.assertActive();};
      function stopConnection(connection:Connection) {
        connection.revision++;
        if(connection.retry!==null){clearTimeout(connection.retry);connection.retry=null;}
        const stop=connection.stop;connection.stop=null;
        try{stop?.();}catch{/* Delivery revision is already invalidated. */}
      }
      function finish(subscription:Subscription,reason?:string) {
        if(subscription.ended)return;
        subscription.ended=true;subscription.epoch++;if(subscription.initialTimer!==null)clearTimeout(subscription.initialTimer);subscription.initialTimer=null;subscriptions.delete(subscription.request.subId);process.total--;
        subscription.connections.forEach(stopConnection);
        if(reason!==undefined&&process.foreground)try{active();subscription.emit(Object.freeze({type:'relay.closed',subId:subscription.request.subId,reason}));}catch{/* Revoked owners receive no lifecycle push. */}
      }
      function emit(subscription:Subscription,message:RelaySubscriptionMessage):boolean {
        if(subscription.ended||!process.foreground)return false;
        try{active();const delivered=subscription.emit(message);
          if(delivered==='paused'){process.foreground=false;for(const value of sessions.values())value.pause();return false;}
          if(!delivered)throw new RelaySubscriptionError();return true;}
        catch{finish(subscription);return false;}
      }
      function eose(subscription:Subscription) {
        if(!subscription.eose&&subscription.connections.some(c=>c.state==='eose')&&subscription.connections.every(c=>c.state!=='opening')) {
          subscription.eose=true;if(subscription.initialTimer!==null)clearTimeout(subscription.initialTimer);subscription.initialTimer=null;emit(subscription,Object.freeze({type:'relay.eose',subId:subscription.request.subId}));
        }
      }
      function connect(subscription:Subscription,connection:Connection) {
        if(subscription.ended||!process.foreground)return;
        try{active();}catch{finish(subscription);return;}
        stopConnection(connection);connection.state='opening';connection.frames=0;connection.windowStart=now();
        const revision=connection.revision,epoch=subscription.epoch;
        const live=()=>!subscription.ended&&process.foreground&&subscription.epoch===epoch&&connection.revision===revision;
        const fail=()=> {
          if(!live())return;
          stopConnection(connection);connection.state='failed';eose(subscription);
          if(connection.attempts>=SUBSCRIPTION_LIMITS.retries) {
            if(subscription.connections.every(c=>c.state==='failed'&&c.attempts>=SUBSCRIPTION_LIMITS.retries))finish(subscription,'relay connection failed');
            return;
          }
          const delay=retryMs[connection.attempts++]!;
          connection.retry=setTimeout(()=>{connection.retry=null;connect(subscription,connection);},delay);
        };
        try {
          connection.id=newId();connection.sub='s'+connection.id.replaceAll('-','');
          const handle=port.open(connection.id,connection.relay,JSON.stringify(['REQ',connection.sub,...subscription.request.filters]),connection.sub,text=> {
            if(!live())return;
            try {
              receiveFrame(process,{active,emit,eose},subscription,connection,text);
            }catch{finish(subscription,'invalid or excessive relay stream');}
          },fail,subscription.authorityToken);
          if(live())connection.stop=handle;else try{handle();}catch{/* Synchronous callbacks may already revoke. */}
        }catch{fail();}
      }
      function deadline(subscription:Subscription) {
        if(!subscription.planned||subscription.eose||subscription.ended)return;
        if(subscription.initialTimer!==null)clearTimeout(subscription.initialTimer);
        subscription.initialTimer=setTimeout(()=> {
          subscription.initialTimer=null;
          if(subscription.ended||!process.foreground)return;
          for(const connection of subscription.connections)if(connection.state==='opening'){stopConnection(connection);connection.state='failed';}
          if(subscription.connections.some(connection=>connection.state==='eose'))eose(subscription);else finish(subscription,'relay timeout');
        },subscription.initialTimeoutMs);
      }
      function resume() {
        try{active();}catch{revoke();return;}
        for(const subscription of Array.from(subscriptions.values())) {
          subscription.epoch++;subscription.eose=false;subscription.backfill=0;
          subscription.connections.forEach(connection=>{connection.attempts=0;connection.state='opening';});
          subscription.connections.forEach(connection=>connect(subscription,connection));deadline(subscription);
        }
      }
      function pause() {for(const subscription of subscriptions.values()){subscription.epoch++;if(subscription.initialTimer!==null)clearTimeout(subscription.initialTimer);subscription.initialTimer=null;subscription.connections.forEach(stopConnection);}}
      function revoke() {
        if(revoked)return;
        revoked=true;for(const subscription of Array.from(subscriptions.values()))finish(subscription);callerIds.clear();sessions.delete(registration.generation);
      }
      sessions.set(registration.generation,{pause,resume,revoke});
      return sessionCommands({registration,process,subscriptions,callerIds,active,connect,deadline,finish,revoke,stopConnection});
}
type CommandScope={registration:NativeRegistration;process:SessionProcess;subscriptions:Map<string,Subscription>;callerIds:Set<string>;
  active:()=>void;connect:(subscription:Subscription,connection:Connection)=>void;deadline:(subscription:Subscription)=>void;
  finish:(subscription:Subscription,reason?:string)=>void;revoke:()=>void;stopConnection:(connection:Connection)=>void};
function sessionCommands(scope:CommandScope) {
  const {registration,process,subscriptions,callerIds,active,connect,deadline,finish,revoke,stopConnection}=scope;
  const destinations=process.destinations;
      function connections(relays:readonly string[]):Connection[] {return relays.map(relay=>({id:'',sub:'',relay,stop:null,retry:null,revision:0,attempts:0,state:'opening',windowStart:0,frames:0}));}
      function plannedRelays(input:readonly string[]):readonly string[] {
        if(!Array.isArray(input)||input.length<1||input.length>OUTBOX_LIST_LIMITS.relays)throw new RelaySubscriptionError('relay plan limit');
        const selected=input.map(normalizeRelayUrl);
        if(new Set(selected).size!==selected.length)throw new RelaySubscriptionError('relay plan duplicate');
        return selected;
      }
      function subscribe(input:unknown,send:Emit,authorityToken?:string,plan?:Readonly<{relays:readonly string[];limit:number;timeoutMs:number}>) {
        active();let request=parseRelaySubscribe(input);
        if(callerIds.has(request.subId)||callerIds.size>=SUBSCRIPTION_LIMITS.callerIds||subscriptions.size>=SUBSCRIPTION_LIMITS.session||process.total>=SUBSCRIPTION_LIMITS.process)throw new RelaySubscriptionError('relay subscription limit or reused ID');
        let selected:readonly string[];
        if(plan) {
          if(!registration.domains.includes('outbox')||request.relay!==undefined||!Number.isSafeInteger(plan.limit)||plan.limit<0||plan.limit>32||!Number.isSafeInteger(plan.timeoutMs)||plan.timeoutMs<1||plan.timeoutMs>15000)throw new RelaySubscriptionError('relay plan denied');
          selected=plannedRelays(plan.relays);
          request=Object.freeze({...request,filters:Object.freeze(request.filters.map(filter=>Object.freeze({...filter,limit:Math.min(filter.limit as number,plan.limit)})))});
        } else {
          const configured=destinations();
          if(!Array.isArray(configured)||configured.length<1||configured.length>MAX_RELAYS_PER_ROLE)throw new RelaySubscriptionError();
          const relays=configured.map(normalizeRelayUrl);
          if(new Set(relays).size!==relays.length||request.relay!==undefined&&!relays.includes(request.relay))throw new RelaySubscriptionError('relay destination denied');
          selected=request.relay===undefined?relays.slice(0,SUBSCRIPTION_LIMITS.relays):[request.relay];
        }
        const subscription:Subscription={request,emit:send,connections:connections(selected),ids:new Set(),ended:false,eose:false,epoch:0,authorityToken,planned:!!plan,backfillLimit:plan?.limit??32,backfill:0,initialTimeoutMs:plan?.timeoutMs??15000,initialTimer:null};
        callerIds.add(request.subId);subscriptions.set(request.subId,subscription);process.total++;
        if(process.foreground){subscription.connections.forEach(connection=>connect(subscription,connection));deadline(subscription);}
      }
      return Object.freeze({
        subscribe,
        /** App-only immutable Outbox routes. Legacy relay.subscribe retains its two-relay profile. */
        subscribePlanned(input:unknown,send:Emit,authorityToken:string,relays:readonly string[],limit:number,timeoutMs=15000) {subscribe(input,send,authorityToken,{relays,limit,timeoutMs});},
        replan(subId:string,relays:readonly string[]) {
          active();const selected=plannedRelays(relays),subscription=subscriptions.get(subId);
          if(!subscription||!subscription.planned)throw new RelaySubscriptionError('relay plan unavailable');
          subscription.epoch++;subscription.eose=false;subscription.backfill=0;
          subscription.connections.forEach(stopConnection);subscription.connections=connections(selected);
          if(process.foreground)subscription.connections.forEach(connection=>connect(subscription,connection));deadline(subscription);
        },
        close(input:unknown){active();const request=parseRelayClose(input),subscription=subscriptions.get(request.subId);if(subscription)finish(subscription);},
        revoke,
      });
}
/** Logical intent survives transport suspension. Generation revocation is terminal. */
export function createRelaySubscriptions(port:NativeRelayStreamPort,destinations:()=>readonly string[],
  options:Readonly<{now?:()=>number;retryMs?:readonly number[]}>= {}) {
  const now=options.now??(()=>performance.now()),retryMs=options.retryMs??SUBSCRIPTION_LIMITS.retryMs;
  if(retryMs.length!==SUBSCRIPTION_LIMITS.retries||retryMs.some(ms=>!Number.isSafeInteger(ms)||ms<1||ms>16000))throw new RelaySubscriptionError();
  let foreground=true,total=0;
  const sessions=new Map<string,{pause:()=>void;resume:()=>void;revoke:()=>void}>();
  const usedOperations=new Set<string>();
  const newId=()=> {
    const id=port.newInstanceId();
    if(!uuid.test(id)||usedOperations.has(id)||usedOperations.size>=65536)throw new RelaySubscriptionError();
    usedOperations.add(id);return id;
  };
  const process:SessionProcess={port,newId,destinations,now,retryMs,sessions,
    get foreground(){return foreground;},set foreground(value){foreground=value;},
    get total(){return total;},set total(value){total=value;}};
  return Object.freeze({
    setForeground(active:boolean) {
      if(foreground===active)return;
      foreground=active;
      for(const session of Array.from(sessions.values()))if(active)session.resume();else session.pause();
    },
    session(owner:RelaySubscriptionOwner) {
      const registration=decodeNativeRegistration(owner.registration);
      if(!registration.domains.includes('relay')||sessions.has(registration.generation)||sessions.size>=SUBSCRIPTION_LIMITS.sessions)throw new RelaySubscriptionError();
      owner.assertActive();
      return createSession(owner,registration,process);
    },
    revokeAll(){for(const session of Array.from(sessions.values()))session.revoke();},
  });
}
