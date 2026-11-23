import {base64} from '@scure/base';
import { requireNativeModule } from 'expo';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import { createNativeResourceHttps, type NativeResourceHttpsPort } from './native-resource-https.ts';
import { createResourceService } from './resource-service.ts';
import { createResourceTransfers } from './resource-transfers.ts';
import type { ResourceHost } from './resource-broker.ts';
/** Native ports, download settings and configured relays stay exclusively in the trusted app. */
export function loadNativeResourceHost(servers: () => readonly string[], query: RelayQueryService): ResourceHost {
  const native = requireNativeModule<NativeResourceHttpsPort & {rasterizeResourceSvg(encoded:string): Promise<string | null>}>('HypergolicNappletHost');
  return Object.freeze({service:createResourceService({https:createNativeResourceHttps(native),servers,query,
    rasterizeSvg:async bytes => {
      const encoded = await native.rasterizeResourceSvg(base64.encode(bytes));
      if (!encoded || encoded.length > 6 * 1024 * 1024) throw new Error('Invalid PNG');
      return Uint8Array.from(base64.decode(encoded));
    },
    sha256:async bytes => Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')}),
    transfers:createResourceTransfers(() => native.newInstanceId())});
}
