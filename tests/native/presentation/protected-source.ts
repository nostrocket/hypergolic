/** Test-only signed local source. Production composition and protected owner stay intact. */
import type {PublishedArtifactSource} from '../../../src/napplets/loader.ts';
import {SIGNED_PRESENTATION_ARTIFACTS} from './published-fixture.ts';
let revision: 'config-caller' | 'config-incompatible-update' = 'config-caller';
export const CONFIGURATION_SAMPLES = SIGNED_PRESENTATION_ARTIFACTS.filter(row =>
  ['config-caller', 'config-collision', 'config-incompatible-update'].includes(row.role));
export function offerIncompatibleConfigurationUpdate() { revision = 'config-incompatible-update'; }
export function createProtectedConfigurationSource(fallback: PublishedArtifactSource): PublishedArtifactSource {
  return {
    async query(coordinate, relays, pinnedEventId, signal) {
      if (signal.aborted) throw new Error('Aborted local source');
      const candidates = CONFIGURATION_SAMPLES.filter(row => coordinate.kind === 35129 &&
        row.event.pubkey === coordinate.pubkey && row.appId === coordinate.identifier);
      if (!candidates.length) return fallback.query(coordinate, relays, pinnedEventId, signal);
      const chosen = pinnedEventId === null
        ? candidates.find(row => row.role === 'config-collision' || row.role === revision)
        : candidates.find(row => row.event.id === pinnedEventId);
      return chosen ? [chosen.event] : [];
    },
    async readHtml(hash, servers, maxBytes, signal) {
      if (signal.aborted) throw new Error('Aborted local source');
      const row = CONFIGURATION_SAMPLES.find(row => row.htmlHash === hash);
      if (!row) return fallback.readHtml(hash, servers, maxBytes, signal);
      const bytes = new TextEncoder().encode(row.html);
      if (bytes.byteLength > maxBytes) throw new Error('Local bytes exceed request bound');
      return bytes;
    },
  };
}
