import {decodeNativePublishedBody, type NativePublishedHttpsPort} from '../napplets/native-published-https.ts';
import {publicResourceHttps} from '../resources/resource-contract.ts';
import {classifyResourceBytes} from '../resources/resource-mime.ts';

export type ProfileAvatarImage = Readonly<{uri: string; cacheKey: string}>;
export type ProfileAvatarReader = (url: string, signal: AbortSignal, assertActive: () => void) => Promise<ProfileAvatarImage>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** App-only transport. Image receives local bytes, never the untrusted profile URL.
 * Native public-address/TLS/foreground/deadline and 2 MiB admission still apply.
 * Existing raster header admission bounds dimensions to 4096; Image owns codec failure.
 */
export function createProfileAvatarReader(native: NativePublishedHttpsPort): ProfileAvatarReader {
  return async (url, signal, assertActive) => {
    const live = () => {if (signal.aborted) throw Error('avatar cancelled'); assertActive();};
    live();
    const destination = publicResourceHttps(url);
    const operation = native.newInstanceId();
    if (!UUID.test(operation)) throw Error('avatar unavailable');
    const cancel = () => {try {native.cancelPublishedHttps(operation);} catch { /* Native deadline remains the backstop. */ }};
    signal.addEventListener('abort', cancel, {once: true});
    try {
      live();
      const encoded = await native.fetchPublishedHttps(operation, destination);
      live();
      const mime = classifyResourceBytes(decodeNativePublishedBody(encoded));
      if (!RASTER_TYPES.has(mime)) throw Error('avatar unavailable');
      live();
      return Object.freeze({uri: `data:${mime};base64,${encoded}`, cacheKey: operation});
    } finally {signal.removeEventListener('abort', cancel);}
  };
}
