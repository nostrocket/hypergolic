import type { PublishedArtifactSource } from './loader.ts';
import {
  EMBEDDED_UPDATE_COORDINATE, EMBEDDED_UPDATE_NADDR, EMBEDDED_UPDATE_V1_EVENT, EMBEDDED_UPDATE_V2_EVENT,
  getEmbeddedUpdateV1HtmlBytes, getEmbeddedUpdateV2HtmlBytes,
} from './embedded-update-fixture.ts';

export { EMBEDDED_UPDATE_NADDR as EMBEDDED_UPDATE_ADDRESS };

/** A test-only transport. Production identity startup never imports this module. */
export function createEmbeddedUpdateSource(expectedLookupRelays: readonly string[]): PublishedArtifactSource & { release(): void } {
  let newestAvailable = false;
  const htmlHash = (event: typeof EMBEDDED_UPDATE_V1_EVENT | typeof EMBEDDED_UPDATE_V2_EVENT) =>
    event.tags.find(tag => tag[0] === 'path')?.[2];
  const v1Hash = htmlHash(EMBEDDED_UPDATE_V1_EVENT);
  const v2Hash = htmlHash(EMBEDDED_UPDATE_V2_EVENT);
  const copy = (event: typeof EMBEDDED_UPDATE_V1_EVENT | typeof EMBEDDED_UPDATE_V2_EVENT) => ({
    id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
    tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig,
  });
  const query: PublishedArtifactSource['query'] = async (coordinate, lookupRelays, pinnedEventId, signal) => {
      if (signal.aborted || coordinate.kind !== EMBEDDED_UPDATE_COORDINATE.kind ||
          coordinate.pubkey !== EMBEDDED_UPDATE_COORDINATE.pubkey ||
          coordinate.identifier !== EMBEDDED_UPDATE_COORDINATE.identifier ||
          lookupRelays.length !== expectedLookupRelays.length ||
          lookupRelays.some((relay, index) => relay !== expectedLookupRelays[index])) throw new Error('Fixture lookup rejected');
      if (pinnedEventId === EMBEDDED_UPDATE_V1_EVENT.id) return [copy(EMBEDDED_UPDATE_V1_EVENT)];
      if (pinnedEventId === EMBEDDED_UPDATE_V2_EVENT.id) return [copy(EMBEDDED_UPDATE_V2_EVENT)];
      if (pinnedEventId !== null) throw new Error('Unknown fixture event');
      return newestAvailable ? [copy(EMBEDDED_UPDATE_V1_EVENT), copy(EMBEDDED_UPDATE_V2_EVENT)]
        : [copy(EMBEDDED_UPDATE_V1_EVENT)];
  };
  const readHtml: PublishedArtifactSource['readHtml'] = async (expectedHash, serverHints, maxBytes, signal) => {
      if (signal.aborted || serverHints.length !== 0) throw new Error('Fixture blob rejected');
      const bytes = expectedHash === v1Hash ? getEmbeddedUpdateV1HtmlBytes()
        : expectedHash === v2Hash ? getEmbeddedUpdateV2HtmlBytes() : null;
      if (!bytes || bytes.length > maxBytes) throw new Error('Fixture blob rejected');
      return bytes;
  };
  return Object.freeze({ release: () => { newestAvailable = true; }, query, readHtml });
}
