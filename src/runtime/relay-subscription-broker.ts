import {decodeNativeRegistration,decodeNativeRequest,type NativeRegistration} from './capability-protocol.ts';
import {parseRelaySubscribe,parseRelayClose} from '../network/relay-subscription-contract.ts';
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
export function createRelaySubscriptionBroker(native:NativeRelaySubscriptionPort,
  manager:ReturnType<typeof createRelaySubscriptions>,owner:Readonly<{registration:NativeRegistration;assertActive():void}>) {
  const registration=decodeNativeRegistration(owner.registration),expected=JSON.stringify(registration);
  const session=manager.session({registration,assertActive:owner.assertActive});
  const tokens=new Map<string,string>();
  let disposed=false,watcher:ReturnType<typeof setInterval>|null=null;
  const active=()=>{if(disposed)throw new Error('Relay owner revoked');owner.assertActive();};
  const stop=(subId:string)=> {
    const token=tokens.get(subId);if(!token)return;
    tokens.delete(subId);native.close(token);
    try{session.close({type:'relay.close',id:'host-close',subId});}catch{revoke();}
    if(tokens.size===0&&watcher!==null){clearInterval(watcher);watcher=null;}
  };
  function revoke() {
    if(disposed)return;disposed=true;
    for(const token of tokens.values())try{native.close(token);}catch{/* Native generation teardown is terminal too. */}
    tokens.clear();session.revoke();if(watcher!==null)clearInterval(watcher);watcher=null;
  }
  return Object.freeze({
    revoke,
    close(input:unknown){active();const request=parseRelayClose(input);stop(request.subId);},
    dispatch(token:string) {
      let accepted=false;
      try {
        active();const raw=native.take(token);if(raw===null)return;
        const captured=decodeNativeRequest(raw);
        if(JSON.stringify(captured.registration)!==expected)throw new Error('Native owner mismatch');
        const request=parseRelaySubscribe(captured.request);
        if(tokens.has(request.subId)||!native.accept(token))throw new Error('Native stream unavailable');
        active();tokens.set(request.subId,token);
        session.subscribe(request,message=> {
          try {
            active();if(!native.isActive(token))throw new Error('Native stream revoked');
            if(!native.mayDeliver(token))return 'paused';
            const delivered=native.send(token,JSON.stringify(message));
            if(message.type==='relay.closed') {
              tokens.delete(request.subId);
              if(tokens.size===0&&watcher!==null){clearInterval(watcher);watcher=null;}
            }
            return delivered;
          }catch{stop(request.subId);return false;}
        },token);
        accepted=true;
        if(tokens.size>0&&watcher===null)watcher=setInterval(()=> {
          try{active();for(const [subId,current] of tokens)if(!native.isActive(current))stop(subId);}
          catch{revoke();}
        },25);
      }catch{/* A rejected native admission never acquires an SDK recipient. */}
      finally{if(!accepted)try{native.close(token);for(const [subId,current] of tokens)if(current===token)stop(subId);}catch{revoke();}}
    },
  });
}
