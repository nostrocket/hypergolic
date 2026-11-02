import { requireNativeModule } from 'expo';
import type { RuntimeNativePort } from './runtime-owner';

interface CapabilityModule {
  newInstanceId(): string;
  takeSubscription(token:string):string|null;
  acceptSubscription(token:string):boolean;
  isSubscriptionActive(token:string):boolean;
  mayDeliverSubscription(token:string):boolean;
  subscriptionCapacity(token:string):boolean;
  sendSubscription(token:string,response:string):number;
  closeSubscription(token:string):void;
  takeCapability(token: string): string | null;
  isCapabilityActive(token: string): boolean;
  finishCapability(token: string, response: string | null): void;
}
export function loadNativeCapabilityPort(): RuntimeNativePort {
  const module = requireNativeModule<CapabilityModule>('HypergolicNappletHost');
  return Object.freeze({ subscriptions:Object.freeze({take:(token:string)=>module.takeSubscription(token),accept:(token:string)=>module.acceptSubscription(token),
    isActive:(token:string)=>module.isSubscriptionActive(token),mayDeliver:(token:string)=>module.mayDeliverSubscription(token),
    canSend:(token:string)=>module.subscriptionCapacity(token),
    send:(token:string,response:string)=>{const result=module.sendSubscription(token,response);return result===0?'paused' as const:result===1;},close:(token:string)=>module.closeSubscription(token)}),newInstanceId: () => module.newInstanceId(), take: (token: string) => module.takeCapability(token),
    isActive: (token: string) => module.isCapabilityActive(token),
    finish: (token: string, response: string | null) => module.finishCapability(token, response) });
}
