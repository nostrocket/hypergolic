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
export function createRelaySubscriptionBroker(native:NativeRelaySubscriptionPort,
  manager:ReturnType<typeof createRelaySubscriptions>,owner:Readonly<{registration:NativeRegistration;assertActive():void}>) {
  const registration=decodeNativeRegistration(owner.registration),expected=JSON.stringify(registration);
  const session=manager.session({registration,assertActive:owner.assertActive});
  const tokens=new Map<string,string>();
  let disposed=false,watcher:ReturnType<typeof setInterval>|null=null;
  const active=()=>{if(disposed)throw new Error('Relay owner revoked');owner.assertActive();};
  function forget(subId:string) {
    tokens.delete(subId);
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
    tokens.clear();session.revoke();if(watcher!==null)clearInterval(watcher);watcher=null;
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
        session.subscribe(selected,message=> {
          try {
            active();if(!native.isActive(token))throw new Error('Native stream revoked');
            if(!native.mayDeliver(token))return 'paused';
            const delivered=native.send(token,JSON.stringify(message));
            if(message.type==='relay.closed') forget(selected.subId);
            return delivered;
          }catch{stop(selected.subId);return false;}
        },token);
        handled=true;
        if(tokens.size>0&&watcher===null)watcher=setInterval(()=> {
          try{active();for(const [subId,current] of tokens)if(!native.isActive(current))stop(subId);}
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
