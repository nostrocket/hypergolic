import { requireNativeModule } from 'expo';
import { adoptNativePublishedBody, type NativePublishedBodyPort } from './native-published-body.ts';
import { NappletHashMismatchError, NappletHtmlEnvelopeError } from './verified-artifact.ts';
import { createNativePublishedArtifactHttpsFetch, type NativePublishedArtifactHttpsPort } from './native-published-https.ts';
import { createNativePublishedRelayLookup, type NativePublishedRelayPort } from './native-published-relay.ts';
import { createNativePublishedArtifactSource } from './published-source.ts';
import type { PublishedArtifactSource } from './loader.ts';

/** Trusted app-side composition for published artifact lookup; never pass this port to a napplet WebView. */
export function loadNativePublishedArtifactSource(): PublishedArtifactSource {
  const nativePort = requireNativeModule<NativePublishedArtifactHttpsPort & NativePublishedRelayPort & NativePublishedBodyPort & {
    retainDownloadedPublishedBody(operation: string, token: string, hash: string): Promise<number>;
  }>('HypergolicNappletHost');
  return createNativePublishedArtifactSource({
    async readVerifiedBody(url, hash, maxBytes, signal) {
      const token = await nativePort.createPublishedBodyToken();
      let id: string | undefined;
      const cancel = () => { if (id) nativePort.cancelPublishedHttps(id); };
      signal.addEventListener('abort', cancel, {once: true});
      let transferred = false;
      try {
        if (signal.aborted) throw new Error('Publication request cancelled');
        id = nativePort.newInstanceId();
        const size = await nativePort.fetchPublishedArtifactHttps(id, url);
        if (signal.aborted) throw new Error('Publication request cancelled');
        if (size < 1 || size > maxBytes) throw new Error('Publication size exceeded');
        const verified = await nativePort.retainDownloadedPublishedBody(id, token, hash);
        if (signal.aborted) throw new Error('Publication request cancelled');
        if (verified === -2) throw new NappletHashMismatchError();
        if (verified === -3) throw new NappletHtmlEnvelopeError();
        if (verified !== size) throw new Error('Publication verification failed');
        const body = adoptNativePublishedBody(nativePort, token, hash, size);
        transferred = true;
        return body;
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        if (!transferred) nativePort.releasePublishedBody(token);
      }
    },
    relayLookup: createNativePublishedRelayLookup(nativePort),
    fetchPublicHttps: createNativePublishedArtifactHttpsFetch(nativePort),
  });
}
