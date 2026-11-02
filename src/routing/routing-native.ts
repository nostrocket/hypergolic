import { requireNativeModule } from 'expo';
import type { RoutingNativePort, RoutingNativeState } from './routing-port';
import { routingRecord } from './routing-contract';
interface RoutingModule {
  routingState(): string;
  mayDeliverRouting(generation: string, revision: number, domain: string): boolean;
  mayReviewRouting(generation: string, revision: number): boolean;
  routingReviewRevision(generation: string, revision: number): number;
  sendRouting(generation: string, revision: number, response: string): boolean;
  newInstanceId(): string;
  addListener(name: 'onRoutingLifecycle', listener: (event: unknown) => void): { remove(): void };
}
export function loadRoutingNativePort(): RoutingNativePort {
  const module = requireNativeModule<RoutingModule>('HypergolicNappletHost');
  return Object.freeze({
    state: () => {
      const value = routingRecord(JSON.parse(module.routingState()), ['user', 'epoch', 'revision', 'available', 'ownerAvailable', 'foreground']);
      if (typeof value.user !== 'string' || !/^[0-9a-f]{64}$/.test(value.user) || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.available !== 'boolean' || typeof value.ownerAvailable !== 'boolean' || typeof value.foreground !== 'boolean') throw new Error('Routing owner unavailable');
      return Object.freeze(value) as RoutingNativeState;
    },
    mayDeliver: (generation: string, revision: number, domain: 'intent' | 'inc' | 'notify' | 'config') => module.mayDeliverRouting(generation, revision, domain),
    mayReview: (generation: string, revision: number) => module.mayReviewRouting(generation, revision),
    reviewRevision: (generation: string, revision: number) => {
      const value = module.routingReviewRevision(generation, revision);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    },
    send: (generation: string, revision: number, message: Readonly<Record<string, unknown>>) => module.sendRouting(generation, revision, JSON.stringify(message)),
    subscribe: (listener: () => void) => { const subscription = module.addListener('onRoutingLifecycle', listener); return () => subscription.remove(); },
    newChannelId: () => module.newInstanceId(),
  });
}
