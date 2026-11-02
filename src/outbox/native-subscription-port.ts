import {loadNativeRelayStreamPort,attachNativeRelayLifecycle} from '../network/native-relay-subscription-port';
import type {OutboxReadService} from './read-service';
import {createOutboxSubscriptions} from './subscriptions';
export function loadNativeOutboxSubscriptions(reads:OutboxReadService) {
  const manager=createOutboxSubscriptions(loadNativeRelayStreamPort(),reads),detach=attachNativeRelayLifecycle(manager);
  return Object.freeze({...manager,dispose(){detach();manager.revokeAll();}});
}
