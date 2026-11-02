import {utf8Bytes} from '../storage/codec.ts';
import type {OutboxSubscriptionMessage} from './subscription-contract.ts';
import {decodeNativeRegistration,decodeNativeRequest,type NativeRegistration} from '../runtime/capability-protocol.ts';
import type {NativeRelaySubscriptionPort} from '../runtime/relay-subscription-broker.ts';
import {parseOutboxSubscribe,parseOutboxClose} from './subscription-contract.ts';
import {createOutboxSubscriptions} from './subscriptions.ts';
/** The native-captured Outbox lane is claimed only here; another broker cannot consume its one-use snapshot. */
export function createOutboxSubscriptionBroker(native:NativeRelaySubscriptionPort,manager:ReturnType<typeof createOutboxSubscriptions>,
  owner:Readonly<{registration:NativeRegistration;assertActive():void}>) {
  const registration=decodeNativeRegistration(owner.registration),expected=JSON.stringify(registration),session=manager.session(owner);
  const tokens=new Map<string,string>(),queues=new Map<string,{messages:string[];bytes:number;terminal:boolean}>();let disposed=false,watcher:ReturnType<typeof setInterval>|null=null;
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
  function drain(subId:string,token:string) {
    const queue=queues.get(subId);if(!queue)return;
    while(queue.messages.length&&native.mayDeliver(token)&&(native.canSend?.(token)??true)) {
      active();if(!native.isActive(token))throw new Error('Native stream revoked');
      const encoded=queue.messages[0]!,message=JSON.parse(encoded),result=native.send(token,encoded);
      if(result==='paused')return;if(!result)throw new Error('Native stream unavailable');
      queue.messages.shift();queue.bytes-=utf8Bytes(encoded);
      if(message.type==='outbox.closed'){queues.delete(subId);tokens.delete(subId);idle();return;}
    }
  }
  function enqueue(subId:string,token:string,message:OutboxSubscriptionMessage):boolean|'paused' {
    active();if(!native.isActive(token))throw new Error('Native stream revoked');
    if(!native.mayDeliver(token))return 'paused';
    const queue=queues.get(subId)!;if(queue.terminal)return false;
    let encoded=JSON.stringify(message),bytes=utf8Bytes(encoded);
    if(bytes>66*1024||queue.messages.length>=32||queue.bytes+bytes>512*1024) {
      queue.messages=[];queue.bytes=0;queue.terminal=true;
      encoded=JSON.stringify({type:'outbox.closed',subId,reason:'outbox delivery limit'});bytes=utf8Bytes(encoded);
      session.close({type:'outbox.close',id:'outbox-delivery-limit',subId});
    }else if(message.type==='outbox.closed')queue.terminal=true;
    queue.messages.push(encoded);queue.bytes+=bytes;drain(subId,token);return true;
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
        active();tokens.set(request.subId,token);queues.set(request.subId,{messages:[],bytes:0,terminal:false});
        session.subscribe(request,message=> {
          try {
            return enqueue(request.subId,token,message);
          }catch{stop(request.subId);return false;}
        },token,()=>{active();if(!native.isActive(token))throw new Error('Native stream revoked');});
        accepted=true;
        if(tokens.size&&watcher===null)watcher=setInterval(()=> {
          try{active();for(const [subId,current] of tokens)if(!native.isActive(current))stop(subId);else drain(subId,current);}catch{revoke();}
        },25);
      }catch{/* A failed native capture acquires no guest recipient or transport. */}
      finally{if(!accepted)try{native.close(token);for(const [subId,current] of tokens)if(current===token)stop(subId);}catch{revoke();}}
    },
  });
}
