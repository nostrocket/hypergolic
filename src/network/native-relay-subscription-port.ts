import {requireNativeModule} from 'expo';
import {createRelaySubscriptions,type NativeRelayStreamPort} from './relay-subscriptions';

interface StreamModule {
  newInstanceId():string;
  startRelayStream(id:string,token:string,url:string,request:string,subId:string):boolean;
  acknowledgeRelayStream(id:string,sequence:number):void;
  cancelRelayStream(id:string):void;
  relayLifecycle():string;
  addListener(name:'onRelayStream'|'onRelayLifecycle',listener:(event:unknown)=>void):{remove():void};
}
/** App-only native stream events; no socket, URL hook or lookup token enters WebView props. */
export function loadNativeRelayStreamPort():NativeRelayStreamPort {
  const module=requireNativeModule<StreamModule>('HypergolicNappletHost');
  const port:NativeRelayStreamPort={newInstanceId:()=>module.newInstanceId(),
    open(id,url,request,subId,frame,failed,token) {
      if(typeof token!=='string')throw new Error('Native relay owner unavailable');
      let live=true,sequence=0;
      const stop=()=>{if(!live)return;live=false;listener.remove();module.cancelRelayStream(id);};
      const listener=module.addListener('onRelayStream',input=> {
        if(!live||!input||typeof input!=='object'||!('operationId' in input)||input.operationId!==id)return;
        const event=input as Record<string,unknown>;
        if(Object.keys(event).length===2&&event.failed===true){stop();failed();return;}
        if(Object.keys(event).length!==3||typeof event.frame!=='string'||new TextEncoder().encode(event.frame).length>66*1024||
          !Number.isSafeInteger(event.sequence)||event.sequence!==sequence+1){stop();failed();return;}
        sequence=event.sequence as number;
        try{frame(event.frame);if(live)module.acknowledgeRelayStream(id,sequence);}
        catch{stop();failed();}
      });
      try{if(!module.startRelayStream(id,token,url,request,subId))throw new Error('Native relay stream unavailable');}
      catch(error){stop();throw error;}
      return stop;
    }};
  return Object.freeze(port);
}
/** Native epochs handle a whole background/return interval even when RN receives only its end. */
export function attachNativeRelayLifecycle(manager:Pick<ReturnType<typeof createRelaySubscriptions>,'setForeground'>):()=>void {
  const module=requireNativeModule<StreamModule>('HypergolicNappletHost');
  let revision=-1;
  manager.setForeground(false);
  const apply=(raw:unknown)=> {
    try {
      if(typeof raw!=='string'||raw.length>256)return;
      const value=JSON.parse(raw);
      if(!value||Object.keys(value).length!==2||typeof value.active!=='boolean'||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision<=revision)return;
      // Invalidate retained connection IDs before honoring a newer native epoch.
      manager.setForeground(false);revision=value.revision;manager.setForeground(value.active);
    }catch{manager.setForeground(false);}
  };
  const listener=module.addListener('onRelayLifecycle',event=>{if(event&&typeof event==='object'&&Object.keys(event).length===1&&'snapshot' in event)apply(event.snapshot);});
  apply(module.relayLifecycle());
  return()=>{listener.remove();manager.setForeground(false);};
}
export function loadNativeRelaySubscriptions(destinations:()=>readonly string[]) {
  const manager=createRelaySubscriptions(loadNativeRelayStreamPort(),destinations);
  const detach=attachNativeRelayLifecycle(manager);
  return Object.freeze({...manager,dispose(){detach();manager.revokeAll();}});
}
