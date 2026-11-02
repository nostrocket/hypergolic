import { naddrEncode } from 'nostr-tools/nip19';
import { verifyArtifact, verifyManifest } from '../../../src/napplets/verified-artifact.ts';

/** Public-only signed revisions for exercising a change to requested access. */
export const CHANGED_ACCESS_PUBLISHER = '803d57d794cf576cbef909cd854a040bddd4a04fc6ea7a36f85a1daf0bc43799';
export const CHANGED_ACCESS_IDENTIFIER = 'hypergolic-changed-access-qa';

const makeEvent = (created_at: number, pathHash: string, aggregateHash: string, id: string, sig: string,
  tags: readonly (readonly string[])[]) => Object.freeze({
  kind: 35129 as const,
  created_at,
  content: '',
  tags: Object.freeze(tags.map(tag => Object.freeze([...tag]))),
  pubkey: CHANGED_ACCESS_PUBLISHER,
  id,
  sig,
});

export const CHANGED_ACCESS_V1_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Changed access fixture</title><style>body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style></head><body><main id="changed-access-marker">changed-access-v1</main><script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';
export const CHANGED_ACCESS_V2_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Changed access fixture</title><style>body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style></head><body><main id="changed-access-marker">changed-access-v2</main><script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';

export const CHANGED_ACCESS_V1_EVENT = makeEvent(1_800_100_000,
  '7cb1490e283e2b35c765b98d486ce9aa00d6d8fc227621b6ea30913ad92ef8ec',
  '6e8d15e729d2a8111643298e582af679a6b6c42d3328adb922fb9af6d5ebdbd3',
  '2bd6f1bfcfbbd1053735e98e9306664577334ecde33f8420f8cbaa638fb2a0ac',
  '78acea71484da517ecc95d9359b8ec535fbcf5811c1225071e4a174e6898474b7c28be33abfabc004bce8568efa8d6bffb8c74bf7e7bb4c8db3ffdde0e100942', [
    ['d', CHANGED_ACCESS_IDENTIFIER],
    ['path', '/index.html', '7cb1490e283e2b35c765b98d486ce9aa00d6d8fc227621b6ea30913ad92ef8ec'],
    ['x', '6e8d15e729d2a8111643298e582af679a6b6c42d3328adb922fb9af6d5ebdbd3', 'aggregate'],
    ['requires', 'theme'],
  ]);

export const CHANGED_ACCESS_V2_EVENT = makeEvent(1_800_100_001,
  '089d841db8401beb50f70d2b0b92fad4fd8d3a2d5b988a4788448bc0a843f053',
  '7b9b7438233ec390df2883b7604df02c924f6259545e17cb428af336db4a40b8',
  '1f7adba5c649f9ab5f5933d658e4aea76c23347d982bbdfe3fa9202155c17beb',
  '1a678ef8fd68577c89b55affb360d03cb359d2a348333671c3611245616e31bbcda4aa1a14d889c4afb28e07750235a68395343220b9a0d1f4affdd114b77c9f', [
    ['d', CHANGED_ACCESS_IDENTIFIER],
    ['path', '/index.html', '089d841db8401beb50f70d2b0b92fad4fd8d3a2d5b988a4788448bc0a843f053'],
    ['x', '7b9b7438233ec390df2883b7604df02c924f6259545e17cb428af336db4a40b8', 'aggregate'],
    ['requires', 'theme'],
    ['requires', 'relay'],
  ]);

export const CHANGED_ACCESS_COORDINATE = Object.freeze({
  kind: 35129 as const,
  pubkey: CHANGED_ACCESS_PUBLISHER,
  identifier: CHANGED_ACCESS_IDENTIFIER,
  relayHints: Object.freeze([] as string[]),
});

export const CHANGED_ACCESS_NADDR = naddrEncode({ kind: 35129, pubkey: CHANGED_ACCESS_PUBLISHER, identifier: CHANGED_ACCESS_IDENTIFIER, relays: [] });

const bytes = (html: string): Uint8Array => new TextEncoder().encode(html);
export const getChangedAccessV1HtmlBytes = (): Uint8Array => bytes(CHANGED_ACCESS_V1_HTML);
export const getChangedAccessV2HtmlBytes = (): Uint8Array => bytes(CHANGED_ACCESS_V2_HTML);

/** Re-verifies the public signatures, NIP-5A hashes, manifests, and artifact bytes. */
export async function loadChangedAccessFixtures() {
  const [v1Manifest, v2Manifest] = await Promise.all([
    verifyManifest(CHANGED_ACCESS_COORDINATE, CHANGED_ACCESS_V1_EVENT),
    verifyManifest(CHANGED_ACCESS_COORDINATE, CHANGED_ACCESS_V2_EVENT),
  ]);
  const [v1Artifact, v2Artifact] = await Promise.all([
    verifyArtifact(v1Manifest, getChangedAccessV1HtmlBytes()),
    verifyArtifact(v2Manifest, getChangedAccessV2HtmlBytes()),
  ]);
  return Object.freeze({
    v1: Object.freeze({ manifest: v1Manifest, artifact: v1Artifact }),
    v2: Object.freeze({ manifest: v2Manifest, artifact: v2Artifact }),
  });
}
