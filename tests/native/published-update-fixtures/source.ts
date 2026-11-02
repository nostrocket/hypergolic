import type { PublishedArtifactSource } from '../../../src/napplets/loader.ts';
import {
  EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_V1_EVENT, EMBEDDED_UPDATE_V2_EVENT,
  getEmbeddedUpdateV1HtmlBytes, getEmbeddedUpdateV2HtmlBytes,
} from '../../../src/napplets/embedded-update-fixture.ts';
import {
  CHANGED_ACCESS_COORDINATE, CHANGED_ACCESS_V1_EVENT, CHANGED_ACCESS_V2_EVENT,
  getChangedAccessV1HtmlBytes, getChangedAccessV2HtmlBytes,
} from '../../napplets/fixtures/changed-access-fixture.ts';

export { EMBEDDED_UPDATE_NADDR as ORIGINAL_PUBLISHED_UPDATE_ADDRESS } from '../../../src/napplets/embedded-update-fixture.ts';
export { CHANGED_ACCESS_NADDR } from '../../napplets/fixtures/changed-access-fixture.ts';

type FixtureEvent = {
  readonly id: string;
  readonly pubkey: string;
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
};
type Revision = Readonly<{ event: FixtureEvent; html: () => Uint8Array }>;
type NappletFixture = Readonly<{ coordinate: typeof EMBEDDED_UPDATE_COORDINATE | typeof CHANGED_ACCESS_COORDINATE;
  revisions: readonly [Revision, Revision] }>;

const fixtures: readonly NappletFixture[] = Object.freeze([
  Object.freeze({ coordinate: EMBEDDED_UPDATE_COORDINATE, revisions: Object.freeze([
    Object.freeze({ event: EMBEDDED_UPDATE_V1_EVENT, html: getEmbeddedUpdateV1HtmlBytes }),
    Object.freeze({ event: EMBEDDED_UPDATE_V2_EVENT, html: getEmbeddedUpdateV2HtmlBytes }),
  ]) as unknown as readonly [Revision, Revision] }),
  Object.freeze({ coordinate: CHANGED_ACCESS_COORDINATE, revisions: Object.freeze([
    Object.freeze({ event: CHANGED_ACCESS_V1_EVENT, html: getChangedAccessV1HtmlBytes }),
    Object.freeze({ event: CHANGED_ACCESS_V2_EVENT, html: getChangedAccessV2HtmlBytes }),
  ]) as unknown as readonly [Revision, Revision] }),
]);

function copyEvent(event: FixtureEvent) {
  return { id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
    tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig };
}

/** Test-only lookup/blob transport with independent visibility toggles for both napplets. */
export function createPublishedUpdateFixtureSource(expectedLookupRelays: readonly string[]): PublishedArtifactSource & {
  releaseUpdate(): void;
  releaseChangedAccess(): void;
} {
  const released = new Set<string>();
  const fixtureFor = (coordinate: { kind: number; pubkey: string; identifier: string }) => fixtures.find(fixture =>
    fixture.coordinate.kind === coordinate.kind && fixture.coordinate.pubkey === coordinate.pubkey &&
    fixture.coordinate.identifier === coordinate.identifier);
  const revisionForId = (id: string) => fixtures.flatMap(fixture => fixture.revisions).find(revision => revision.event.id === id);

  const query: PublishedArtifactSource['query'] = async (coordinate, lookupRelays, pinnedEventId, signal) => {
    if (signal.aborted || lookupRelays.length !== expectedLookupRelays.length ||
        lookupRelays.some((relay, index) => relay !== expectedLookupRelays[index])) throw new Error('Fixture lookup rejected');
    const fixture = fixtureFor(coordinate);
    if (!fixture) throw new Error('Fixture coordinate rejected');
    if (pinnedEventId !== null) {
      const revision = revisionForId(pinnedEventId);
      if (!revision || !fixture.revisions.includes(revision)) throw new Error('Unknown fixture event');
      return [copyEvent(revision.event)];
    }
    const visible = released.has(fixture.coordinate.identifier) ? fixture.revisions : [fixture.revisions[0]];
    return visible.map(revision => copyEvent(revision.event));
  };

  const readHtml: PublishedArtifactSource['readHtml'] = async (expectedHash, serverHints, maxBytes, signal) => {
    if (signal.aborted || serverHints.length !== 0) throw new Error('Fixture blob rejected');
    for (const fixture of fixtures) {
      const revision = fixture.revisions.find(item => item.event.tags.some(tag => tag[0] === 'path' && tag[2] === expectedHash));
      if (!revision) continue;
      const bytes = revision.html();
      if (bytes.length > maxBytes) throw new Error('Fixture blob rejected');
      return bytes;
    }
    throw new Error('Fixture blob rejected');
  };

  return Object.freeze({
    releaseUpdate: () => { released.add(EMBEDDED_UPDATE_COORDINATE.identifier); },
    releaseChangedAccess: () => { released.add(CHANGED_ACCESS_COORDINATE.identifier); },
    query,
    readHtml,
  });
}
