import type { VerifiedNappletArtifact, VerifiedNappletManifest } from './verified-artifact.ts';
import { verifyArtifact, verifyManifest } from './verified-artifact.ts';
import { naddrEncode } from 'nostr-tools/nip19';

/** Fixed public key for a disposable local update fixture. The signing secret was discarded. */
export const EMBEDDED_UPDATE_PUBLISHER = '638cd26c28fb52d057f424d11a14e24526ac4b5e08cbad5d6c36f8f57cacce2f';
export const EMBEDDED_UPDATE_IDENTIFIER = 'hypergolic-update-qa';

export const EMBEDDED_UPDATE_V1_HTML = '<!doctype html><html><head><title>Update fixture</title><style>body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style></head><body><main id="update-marker">update-v1</main><script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';
export const EMBEDDED_UPDATE_V2_HTML = '<!doctype html><html><head><title>Update fixture</title><style>body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style></head><body><main id="update-marker">update-v2</main><script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';

function signedFixtureEvent(created_at: number, pathHash: string, aggregateHash: string, id: string, sig: string) {
  return Object.freeze({ kind: 35129 as const, created_at, content: '',
    tags: Object.freeze([
      Object.freeze(['d', EMBEDDED_UPDATE_IDENTIFIER]),
      Object.freeze(['path', '/index.html', pathHash]),
      Object.freeze(['x', aggregateHash, 'aggregate']),
      Object.freeze(['requires', 'theme']),
    ]),
    pubkey: EMBEDDED_UPDATE_PUBLISHER, id, sig,
  });
}

/** Immutable signed public-only kind-35129 events; neither has been published. */
export const EMBEDDED_UPDATE_V1_EVENT = signedFixtureEvent(1_800_000_000,
  'bd67c412d8411943644886a9d52e4935314f94595a3b20868db625de1084490c',
  '07fa7050e7af8c9cb02700ac832a6be63bc0ebbca3419b88700d3fa4c7a33de2',
  'dc078ef5973560de09933f39f19dddc28c51b2b30c7ec505157442db665a48b1',
  'f598cf343e3a1fbc5010dc84993298a074e92ae9361607a615b2e548618ddaffaaa527cc58cdbf862d7b7a0bf4e51b75d918b7aa18034f868d91d231c9fcdbaa');
export const EMBEDDED_UPDATE_V2_EVENT = signedFixtureEvent(1_800_000_001,
  '6e64c84753465ae5cbb5f8fa84226cb1b00978f9e81254a9ee4509977b3aa866',
  '49f505b7f56e134a8e1389254507f754b6ac2bcb83cc11563ada4d520b12a3c5',
  'df50ad4aa2bcbc0514f75a63ca72c0dfb12da1b1e9e199f551bd6d2d98a71640',
  '11bddbd3a005b7f52bfa95d040dfc4fbf24826a849efd3039bcf35a3578e2492cc1f00c25e0712a16fc6491e9605e80593c4c782800820bc6cbc7a4caea0723d');

export const EMBEDDED_UPDATE_COORDINATE = Object.freeze({
  kind: 35129 as const,
  pubkey: EMBEDDED_UPDATE_PUBLISHER,
  identifier: EMBEDDED_UPDATE_IDENTIFIER,
  relayHints: Object.freeze([] as string[]),
});
export const EMBEDDED_UPDATE_NADDR = naddrEncode({ kind: 35129, pubkey: EMBEDDED_UPDATE_PUBLISHER, identifier: EMBEDDED_UPDATE_IDENTIFIER, relays: [] });
export const EMBEDDED_UPDATE_OLD_EVENT = EMBEDDED_UPDATE_V1_EVENT;
export const EMBEDDED_UPDATE_NEW_EVENT = EMBEDDED_UPDATE_V2_EVENT;

const bytes = (html: string): Uint8Array => new TextEncoder().encode(html);
export const getEmbeddedUpdateV1HtmlBytes = (): Uint8Array => bytes(EMBEDDED_UPDATE_V1_HTML);
export const getEmbeddedUpdateV2HtmlBytes = (): Uint8Array => bytes(EMBEDDED_UPDATE_V2_HTML);
export const EMBEDDED_UPDATE_OLD_HTML_BYTES = getEmbeddedUpdateV1HtmlBytes;
export const EMBEDDED_UPDATE_NEW_HTML_BYTES = getEmbeddedUpdateV2HtmlBytes;

export type VerifiedEmbeddedUpdateFixture = Readonly<{
  manifest: VerifiedNappletManifest;
  artifact: VerifiedNappletArtifact;
}>;

/** Independently verifies each signature, path hash and aggregate before returning branded artifacts. */
export async function loadEmbeddedUpdateFixtures(): Promise<Readonly<{
  v1: VerifiedEmbeddedUpdateFixture;
  v2: VerifiedEmbeddedUpdateFixture;
}>> {
  const firstManifest = await verifyManifest(EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_V1_EVENT);
  const secondManifest = await verifyManifest(EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_V2_EVENT);
  const [firstArtifact, secondArtifact] = await Promise.all([
    verifyArtifact(firstManifest, getEmbeddedUpdateV1HtmlBytes()),
    verifyArtifact(secondManifest, getEmbeddedUpdateV2HtmlBytes()),
  ]);
  return Object.freeze({
    v1: Object.freeze({ manifest: firstManifest, artifact: firstArtifact }),
    v2: Object.freeze({ manifest: secondManifest, artifact: secondArtifact }),
  });
}
