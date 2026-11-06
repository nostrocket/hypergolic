import { requireNativeModule } from 'expo';
import { createNativePublishedArtifactHttpsFetch, type NativePublishedArtifactHttpsPort } from './native-published-https.ts';
import { createNativePublishedRelayLookup, type NativePublishedRelayPort } from './native-published-relay.ts';
import { createNativePublishedArtifactSource } from './published-source.ts';
import type { PublishedArtifactSource } from './loader.ts';

/** Trusted app-side composition for published artifact lookup; never pass this port to a napplet WebView. */
export function loadNativePublishedArtifactSource(): PublishedArtifactSource {
  const nativePort = requireNativeModule<NativePublishedArtifactHttpsPort & NativePublishedRelayPort>('HypergolicNappletHost');
  return createNativePublishedArtifactSource({
    relayLookup: createNativePublishedRelayLookup(nativePort),
    fetchPublicHttps: createNativePublishedArtifactHttpsFetch(nativePort),
  });
}
