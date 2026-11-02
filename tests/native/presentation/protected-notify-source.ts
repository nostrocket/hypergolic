/** Test-only signed notification source; retains ordinary protected identity authority. */
import type {PublishedArtifactSource} from '../../../src/napplets/loader.ts';
import {SIGNED_PRESENTATION_ARTIFACTS} from './published-fixture.ts';
let revision: 'caller' | 'notify-update' = 'caller';
export function offerNotificationUpdate() { revision = 'notify-update'; }
export const NOTIFICATION_SAMPLES = SIGNED_PRESENTATION_ARTIFACTS.filter(row =>
  ['caller','peer','notify-collision','no-notify','notify-update'].includes(row.role));
export function createProtectedNotificationSource(fallback: PublishedArtifactSource): PublishedArtifactSource {
  return {
    async query(coordinate, relays, pinnedEventId, signal) {
      if (signal.aborted) throw new Error('Aborted local source');
      const candidates = NOTIFICATION_SAMPLES.filter(row => coordinate.kind === 35129 &&
        row.event.pubkey === coordinate.pubkey && row.appId === coordinate.identifier);
      if (!candidates.length) return fallback.query(coordinate, relays, pinnedEventId, signal);
      const chosen = pinnedEventId === null
        ? candidates.find(row => row.role === revision || !['caller','notify-update'].includes(row.role))
        : candidates.find(row => row.event.id === pinnedEventId);
      return chosen ? [chosen.event] : [];
    },
    async readHtml(hash, servers, maxBytes, signal) {
      if (signal.aborted) throw new Error('Aborted local source');
      const row = NOTIFICATION_SAMPLES.find(row => row.htmlHash === hash);
      if (!row) return fallback.readHtml(hash, servers, maxBytes, signal);
      const bytes = new TextEncoder().encode(row.html);
      if (bytes.byteLength > maxBytes) throw new Error('Local bytes exceed request bound');
      return bytes;
    },
  };
}
