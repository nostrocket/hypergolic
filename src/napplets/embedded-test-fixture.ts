import type { VerifiedNappletArtifact, VerifiedNappletManifest } from './verified-artifact.ts';
import { verifyArtifact, verifyManifest } from './verified-artifact.ts';

/** Fixed, public test publisher key. Its generation secret was discarded. */
export const EMBEDDED_TEST_PUBLISHER = 'cb9e62b0a9bdb390be102d17ecd9f1c652824723229577066d938d5cbee4a6e3';
export const EMBEDDED_TEST_IDENTIFIER = 'hypergolic-qa-embedded';

/** Small executable page used to exercise the native published-artifact path. */
export const EMBEDDED_TEST_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Hypergolic QA Napplet</title><style>html{color-scheme:dark}body{margin:0;background:#1b1612;color:#f8f5f2;font:600 20px system-ui;padding:24px}</style></head><body><main id="status">fixture-loaded</main><script>window.parent.postMessage({type:"shell.ready"},"*");</script></body></html>';

const utf8 = new TextEncoder().encode(EMBEDDED_TEST_HTML);

/** Returns a defensive copy so callers cannot alter the fixture's canonical bytes. */
export function getEmbeddedTestHtmlBytes(): Uint8Array { return new Uint8Array(utf8); }

const rawEvent = {
  kind: 35129,
  created_at: 1_800_000_000,
  content: '',
  tags: [
    ['d', EMBEDDED_TEST_IDENTIFIER],
    ['path', '/index.html', '34d8462c3b471aa01f1149f58441d200bd194d3097d36321777018a0a2adf1d5'],
    ['x', 'e1f514399537f8ff98ce2f842b6fbeb4f1f70edb82dde934197b2031184e4934', 'aggregate'],
    ['requires', 'theme'],
  ],
  pubkey: EMBEDDED_TEST_PUBLISHER,
  id: 'abc35c0b0d09e6934d94321f66fd309b62a2d92031d5501cbbdf175bddf049f6',
  sig: 'e79e3c84fae10348d0b69e522b6043cd9691a647ed9d0f8fef29826e4b112e47c9571bbf6c19923df16e833475a037cc63558f199d7ac716c917bbf28156aeff',
} as const;

/** Immutable signed NIP-5A kind-35129 event. It is a local fixture, not published. */
export const EMBEDDED_TEST_EVENT = Object.freeze({
  ...rawEvent,
  tags: Object.freeze(rawEvent.tags.map(tag => Object.freeze([...tag]))),
});

export const EMBEDDED_TEST_COORDINATE = Object.freeze({
  kind: 35129 as const,
  pubkey: EMBEDDED_TEST_PUBLISHER,
  identifier: EMBEDDED_TEST_IDENTIFIER,
  relayHints: Object.freeze([] as string[]),
});

/** Public metadata a settings-only QA host can show before the explicit Open action. */
export const embeddedTestClaims = Object.freeze({
  publisher: EMBEDDED_TEST_PUBLISHER,
  identifier: EMBEDDED_TEST_IDENTIFIER,
  eventId: EMBEDDED_TEST_EVENT.id,
  event: EMBEDDED_TEST_EVENT,
  requiredDomains: Object.freeze(['theme'] as const),
});

export class EmbeddedTestFixtureError extends Error {
  readonly stage: 'manifest' | 'html';
  constructor(stage: 'manifest' | 'html') {
    super(`Embedded test verification failed at ${stage}`);
    this.stage = stage;
  }
}

/** Independently checks the frozen event signature, path hash, aggregate and original bytes. */
export async function verifyEmbeddedTestFixture(): Promise<{
  manifest: VerifiedNappletManifest;
  artifact: VerifiedNappletArtifact;
}> {
  const manifest = await verifyManifest(EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT)
    .catch(() => { throw new EmbeddedTestFixtureError('manifest'); });
  const artifact = await verifyArtifact(manifest, getEmbeddedTestHtmlBytes())
    .catch(() => { throw new EmbeddedTestFixtureError('html'); });
  return Object.freeze({ manifest, artifact });
}

/** Returns only the verifier-branded fixed artifact; no network fetch or signer is involved. */
export async function loadEmbeddedTestArtifact(): Promise<VerifiedNappletArtifact> {
  return (await verifyEmbeddedTestFixture()).artifact;
}
