import {createRelaySubscriptions, type NativeRelayStreamPort, type RelaySubscriptionOwner} from '../network/relay-subscriptions.ts';
import {decodeNativeRegistration} from '../runtime/capability-protocol.ts';
import {SUBSCRIPTION_LIMITS} from '../network/relay-subscription-contract.ts';
import {OutboxQueryError} from './query-contract.ts';
import type {OutboxReadService} from './read-service.ts';
import {parseOutboxSubscribe, parseOutboxClose, type OutboxSubscribeRequest, type OutboxSubscriptionMessage} from './subscription-contract.ts';
type Emit = (message:OutboxSubscriptionMessage) => boolean | 'paused';
type Row = {request:OutboxSubscribeRequest;emit:Emit;token:string;started:boolean;ended:boolean;revision:number;controller:AbortController|null;assertActive:()=>void};
/** Native epochs stop transport immediately; every return resolves fresh metadata before opening replacement sockets. */
export function createOutboxSubscriptions(port:NativeRelayStreamPort,reads:OutboxReadService) {
  if(!reads.plan)throw new OutboxQueryError('policy denied');
  const manager=createRelaySubscriptions(port,()=>[]),sessions=new Map<string,ReturnType<typeof session>>();
  let foreground=true,epoch=0,total=0,planning=0;
  const waiting=new Set<()=>void>();
  async function slot(signal:AbortSignal):Promise<()=>void> {
    if(planning>=2)await new Promise<void>((resolve,reject)=> {
      const begin=()=>{signal.removeEventListener('abort',cancel);waiting.delete(begin);planning++;resolve();};
      const cancel=()=>{waiting.delete(begin);signal.removeEventListener('abort',cancel);reject(new OutboxQueryError('relay timeout'));};
      waiting.add(begin);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    });else planning++;
    const release=()=>{planning--;waiting.values().next().value?.();};
    if(signal.aborted){release();throw new OutboxQueryError('relay timeout');}
    return release;
  }
  async function routeAll(current:number) {
    await Promise.all([...sessions.values()].map(value=>value.refresh()));
    if(foreground&&epoch===current)manager.setForeground(true);
  }
  function session(owner:RelaySubscriptionOwner) {
    const registration=decodeNativeRegistration(owner.registration);
    if(!registration.domains.includes('outbox')||!registration.domains.includes('relay')||sessions.has(registration.generation)||sessions.size>=SUBSCRIPTION_LIMITS.sessions)throw new OutboxQueryError('policy denied');
    let revoked=false;
    const active=()=>{if(revoked)throw new OutboxQueryError('policy denied');owner.assertActive();};
    active();const transport=manager.session({registration,assertActive:active}),rows=new Map<string,Row>(),used=new Set<string>();
    function stop(row:Row,reason?:string) {
      if(row.ended)return;row.ended=true;row.revision++;row.controller?.abort();rows.delete(row.request.subId);total--;
      if(row.started)try{transport.close({type:'relay.close',id:'outbox-owner-close',subId:row.request.subId});}catch{/* Native teardown remains terminal. */}
      if(reason!==undefined&&foreground)try{active();row.emit({type:'outbox.closed',subId:row.request.subId,reason});}catch{/* No stale recipient. */}
    }
    function forward(row:Row,message:import('../network/relay-subscription-contract.ts').RelaySubscriptionMessage):boolean|'paused' {
            try {
              active();if(row.ended)return false;
              const mapped:OutboxSubscriptionMessage=message.type==='relay.event'?{...message,type:'outbox.event'}:message.type==='relay.closed'?{...message,type:'outbox.closed'}:message;
              const delivered=row.emit(mapped);
              if(message.type==='relay.closed')stop(row);
              return delivered;
            } catch {stop(row);return false;}

    }
    async function route(row:Row,refresh:boolean) {
      if(row.ended||!foreground)return;
      row.controller?.abort();const controller=new AbortController(),revision=++row.revision,capturedEpoch=epoch;
      row.controller=controller;const startedAt=Date.now();
      const timer=setTimeout(()=>controller.abort(),row.request.options.timeoutMs);let release:(()=>void)|undefined;
      const current=()=>{active();row.assertActive();if(row.ended||row.revision!==revision||capturedEpoch!==epoch||!foreground||controller.signal.aborted)throw new OutboxQueryError('relay timeout');};
      try {
        release=await slot(controller.signal);current();
        const remaining=row.request.options.timeoutMs-(Date.now()-startedAt);if(remaining<1)throw new OutboxQueryError('relay timeout');
        const plan=await reads.plan!({type:'outbox.query',id:row.request.id,filters:row.request.filters,options:{...row.request.options,timeoutMs:remaining}},registration.user,controller.signal,current,refresh);
        current();
        if(row.started)transport.replan(row.request.subId,plan.relays);
        else {
          const timeoutMs=row.request.options.timeoutMs-(Date.now()-startedAt);
          if(timeoutMs<1)throw new OutboxQueryError('relay timeout');
          transport.subscribePlanned({type:'relay.subscribe',id:row.request.id,subId:row.request.subId,filters:row.request.filters},message=>forward(row,message),row.token,plan.relays,row.request.options.limit,timeoutMs);
          row.started=true;
        }
      } catch {
        if(!row.ended&&row.revision===revision&&capturedEpoch===epoch&&foreground)stop(row,'relay list unavailable or timed out');
      } finally {clearTimeout(timer);release?.();if(row.controller===controller)row.controller=null;}
    }
    const value=Object.freeze({
      subscribe(input:unknown,emit:Emit,token:string,assertLease:()=>void=()=>{}) {
        active();const request=parseOutboxSubscribe(input);
        if(used.has(request.subId)||used.size>=SUBSCRIPTION_LIMITS.callerIds||rows.size>=SUBSCRIPTION_LIMITS.session||total>=SUBSCRIPTION_LIMITS.process)throw new OutboxQueryError('policy denied');
        used.add(request.subId);const row:Row={request,emit,token,started:false,ended:false,revision:0,controller:null,assertActive:assertLease};rows.set(request.subId,row);total++;
        void route(row,false);
      },
      close(input:unknown){active();const request=parseOutboxClose(input),row=rows.get(request.subId);if(row)stop(row);},
      pause(){for(const row of rows.values()){row.revision++;row.controller?.abort();row.controller=null;}},
      async refresh(){await Promise.all(Array.from(rows.values(),row=>route(row,true)));},
      revoke(){if(revoked)return;revoked=true;for(const row of rows.values())stop(row);transport.revoke();sessions.delete(registration.generation);used.clear();},
    });
    sessions.set(registration.generation,value);return value;
  }
  return Object.freeze({session,
    setForeground(value:boolean) {
      if(foreground===value)return;foreground=value;epoch++;manager.setForeground(false);
      for(const value of sessions.values())value.pause();
      if(value)void routeAll(epoch);
    },
    revokeAll(){epoch++;for(const value of sessions.values())value.revoke();manager.revokeAll();},
  });
}
