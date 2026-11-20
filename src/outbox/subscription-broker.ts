import {decodeNativeRegistration,decodeNativeRequest,type NativeRegistration} from '../runtime/capability-protocol.ts';
import {createStreamDeliveryQueue,type NativeRelaySubscriptionPort} from '../runtime/relay-subscription-broker.ts';
import {parseOutboxSubscribe,parseOutboxClose} from './subscription-contract.ts';
import {createOutboxSubscriptions} from './subscriptions.ts';
/** The native-captured Outbox lane is claimed only here; another broker cannot consume its one-use snapshot. */
export function createOutboxSubscriptionBroker(native:NativeRelaySubscriptionPort,manager:ReturnType<typeof createOutboxSubscriptions>,
  owner:Readonly<{registration:NativeRegistration;assertActive():void}>) {
  const registration=decodeNativeRegistration(owner.registration),expected=JSON.stringify(registration),session=manager.session(owner);
  const tokens=new Map<string,string>(),queues=new Map<string,ReturnType<typeof createStreamDeliveryQueue>>();let disposed=false,watcher:ReturnType<typeof setInterval>|null=null;
  const active=()=>{if(disposed)throw new Error('Outbox owner revoked');owner.assertActive();};
  const idle=()=>{if(tokens.size===0&&watcher!==null){clearInterval(watcher);watcher=null;}};
  function stop(subId:string) {
    const token=tokens.get(subId);if(!token)return;tokens.delete(subId);queues.delete(subId);
    try{native.close(token);session.close({type:'outbox.close',id:'outbox-owner-close',subId});}catch{revoke();}idle();
  }
  function revoke() {
    if(disposed)return;disposed=true;
    for(const token of tokens.values())try{native.close(token);}catch{/* Native view teardown is terminal. */}
    tokens.clear();queues.clear();session.revoke();idle();
  }
  return Object.freeze({revoke,close(input:unknown){active();stop(parseOutboxClose(input).subId);},
    dispatch(token:string) {
      let accepted=false;
      try {
        active();const raw=native.take(token);if(raw===null)return;
        const captured=decodeNativeRequest(raw);
        if(JSON.stringify(captured.registration)!==expected)throw new Error('Native owner mismatch');
        const request=parseOutboxSubscribe(captured.request);
        if(tokens.has(request.subId)||!native.accept(token))throw new Error('Native admission unavailable');
        active();tokens.set(request.subId,token);const queue=createStreamDeliveryQueue(native,token,request.subId,'outbox',active,
          ()=>session.close({type:'outbox.close',id:'outbox-delivery-limit',subId:request.subId}),
          ()=>{queues.delete(request.subId);tokens.delete(request.subId);idle();});
        queues.set(request.subId,queue);
        session.subscribe(request,message=> {
          try {
            return queue.send(message);
          }catch{stop(request.subId);return false;}
        },token,()=>{active();if(!native.isActive(token))throw new Error('Native stream revoked');});
        accepted=true;
        if(tokens.size&&watcher===null)watcher=setInterval(()=> {
          try{active();for(const [subId,current] of tokens)if(!native.isActive(current))stop(subId);else queues.get(subId)?.drain();}catch{revoke();}
        },25);
      }catch{/* A failed native capture acquires no guest recipient or transport. */}
      finally{if(!accepted)try{native.close(token);for(const [subId,current] of tokens)if(current===token)stop(subId);}catch{revoke();}}
    },
  });
}
