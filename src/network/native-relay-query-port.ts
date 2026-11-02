import { requireNativeModule } from 'expo';
import type { NativePublishedRelayPort } from '../napplets/native-published-relay';
import { createNativeRelayQuery } from './native-relay-query';

/** This process-owned port is never passed into WebView props or guest code. */
export function loadNativeRelayQuery(destinations: () => readonly string[]) {
  const port = requireNativeModule<NativePublishedRelayPort>('HypergolicNappletHost');
  return createNativeRelayQuery(port, destinations);
}
