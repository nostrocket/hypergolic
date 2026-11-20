import {utf8Bytes} from '../storage/codec.ts';
import {decodeNativeRegistration,decodeNativeRequest,type NativeRegistration} from './capability-protocol.ts';
import {parseRelaySubscribe,parseRelayClose,type RelaySubscribeRequest} from '../network/relay-subscription-contract.ts';
import {createRelaySubscriptions} from '../network/relay-subscriptions.ts';

/** Immutable native admission and final native delivery authority remain app-only. */
export interface NativeRelaySubscriptionPort {
  take(token:string):string|null;
  accept(token:string):boolean;
  isActive(token:string):boolean;
  mayDeliver(token:string):boolean;
  canSend?(token:string):boolean;
  send(token:string,response:string):boolean|'paused';
  close(token:string):void;
}
export function createStreamDeliveryQueue(native:NativeRelaySubscriptionPort, token:string, subId:string,
  domain:'relay'|'outbox', active:()=>void, stopProducer:()=>void, terminalSent:()=>void) {
  const messages:{wire:string;bytes:number;terminal:boolean}[]=[];
  let queuedBytes=0,closing=false;
  function drain() {
    while(messages.length && native.mayDeliver(token) && (native.canSend?.(token) ?? true)) {
      active();
      if(!native.isActive(token))throw new Error('Native stream revoked');
      const row=messages[0]!, sent=native.send(token,row.wire);
      if(sent==='paused')return;
      if(!sent)throw new Error('Native stream unavailable');
      messages.shift();queuedBytes-=row.bytes;
      if(row.terminal){terminalSent();return;}
    }
  }
  return {drain,send(message:{type:string;subId:string}):boolean|'paused' {
    active();
    if(!native.isActive(token))throw new Error('Native stream revoked');
    if(!native.mayDeliver(token))return 'paused';
    if(closing)return false;
    let wire=JSON.stringify(message),bytes=utf8Bytes(wire);
    closing=message.type===domain+'.closed';
    if(bytes>66*1024 || messages.length>=32 || queuedBytes+bytes>512*1024) {
      messages.length=0;queuedBytes=0;closing=true;
      wire=JSON.stringify({type:domain+'.closed',subId,reason:domain+' delivery limit'});bytes=utf8Bytes(wire);
      stopProducer();
    }
    messages.push({wire,bytes,terminal:closing});queuedBytes+=bytes;drain();return true;
  }};
}
export function createRelaySubscriptionBroker(native:NativeRelaySubscriptionPort,
  manager:ReturnType<typeof createRelaySubscriptions>,owner:Readonly<{registration:NativeRegistration;assertActive():void}>) {
  const registration=decodeNativeRegistration(owner.registration),expected=JSON.stringify(registration);
  const session=manager.session({registration,assertActive:owner.assertActive});
  const tokens=new Map<string,string>(),queues=new Map<string,ReturnType<typeof createStreamDeliveryQueue>>();
  let disposed=false,watcher:ReturnType<typeof setInterval>|null=null;
  const active=()=>{if(disposed)throw new Error('Relay owner revoked');owner.assertActive();};
  function forget(subId:string) {
    tokens.delete(subId);queues.delete(subId);
    if(tokens.size===0&&watcher!==null){clearInterval(watcher);watcher=null;}
  }
  const stop=(subId:string)=> {
    const token=tokens.get(subId);if(!token)return;
    forget(subId);native.close(token);
    try{session.close({type:'relay.close',id:'host-close',subId});}catch{revoke();}
  };
  function revoke() {
    if(disposed)return;disposed=true;
    for(const token of tokens.values())try{native.close(token);}catch{/* Native generation teardown is terminal too. */}
    tokens.clear();queues.clear();session.revoke();if(watcher!==null)clearInterval(watcher);watcher=null;
  }
  return Object.freeze({
    revoke,
    close(input:unknown){active();const request=parseRelayClose(input);stop(request.subId);},
    dispatch(token:string) {
      let handled=false, request:RelaySubscribeRequest|undefined;
      try {
        active();const raw=native.take(token);if(raw===null)return;
        const captured=decodeNativeRequest(raw);
        if(JSON.stringify(captured.registration)!==expected)throw new Error('Native owner mismatch');
        const selected=parseRelaySubscribe(captured.request);
        request=selected;
        if(tokens.has(selected.subId)||!native.accept(token))throw new Error('Native stream unavailable');
        active();tokens.set(selected.subId,token);
        const queue=createStreamDeliveryQueue(native,token,selected.subId,'relay',active,
          ()=>session.close({type:'relay.close',id:'relay-delivery-limit',subId:selected.subId}),()=>forget(selected.subId));
        queues.set(selected.subId,queue);
        session.subscribe(selected,message=> {
          try {
            return queue.send(message);
          }catch{stop(selected.subId);return false;}
        },token);
        handled=true;
        if(tokens.size>0&&watcher===null)watcher=setInterval(()=> {
          try{active();for(const [subId,current] of tokens)if(!native.isActive(current))stop(subId);else queues.get(subId)?.drain();}
          catch{revoke();}
        },25);
      }catch{
        // Only an exact, accepted native token can report a rejected stream start.
        if(request&&tokens.get(request.subId)===token) {
          try {
            active();
            const terminal={type:'relay.closed',subId:request.subId,reason:'relay subscription unavailable'};
            handled=native.isActive(token)&&native.mayDeliver(token)&&native.send(token,JSON.stringify(terminal))===true;
            if(handled)forget(request.subId); // Native transport retains this terminal until ACK.
          }catch{/* Revoked or undeliverable recipients have no terminal push. */}
        }
      }finally{if(!handled)try{
        if(request&&tokens.get(request.subId)===token)stop(request.subId);else native.close(token);
      }catch{revoke();}}
    },
  });
}
