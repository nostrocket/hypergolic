import { requireNativeModule } from 'expo';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import { createNativeResourceHttps, type NativeResourceHttpsPort } from './native-resource-https.ts';
import { createResourceService } from './resource-service.ts';
import { createResourceTransfers } from './resource-transfers.ts';
import type { ResourceHost } from './resource-broker.ts';
/** Native ports, download settings and configured relays stay exclusively in the trusted app. */
export function loadNativeResourceHost(servers: () => readonly string[], query: RelayQueryService): ResourceHost {
  const native = requireNativeModule<NativeResourceHttpsPort>('HypergolicNappletHost');
  return Object.freeze({service:createResourceService({https:createNativeResourceHttps(native),servers,query,
    sha256:async bytes => Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')}),
    transfers:createResourceTransfers(() => native.newInstanceId())});
}
