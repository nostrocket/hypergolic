import { resolveNappletLink, type NappletCoordinate } from './resolve-link.ts';
import { MAX_RELAYS_PER_ROLE, normalizeRelayUrl } from '../network/relay-settings.ts';
import { verifyArtifact, verifyManifest, type VerifiedNappletArtifact, type VerifiedNappletManifest } from './verified-artifact.ts';

/** The source receives only the verified coordinate, never untrusted encoded relay hints. */
export type NappletLookupCoordinate = Pick<NappletCoordinate, 'kind' | 'pubkey' | 'identifier'>;
/** Trusted transport hooks. Neither relay replies nor blob servers grant execution authority. */
export interface PublishedArtifactSource {
  query(coordinate: NappletLookupCoordinate, lookupRelays: readonly string[], pinnedEventId: string | null,
    signal: AbortSignal): Promise<readonly unknown[]>;
  readHtml(expectedHash: string, serverHints: readonly string[], maxBytes: number,
    signal: AbortSignal): Promise<Uint8Array>;
}
export interface PublishedLoadOptions {
  readonly source: PublishedArtifactSource;
  readonly lookupRelays: readonly string[];
  readonly signal: AbortSignal;
  /** Reopening an installed version must never substitute a newer or older event. */
  readonly pinnedEventId?: string;
  /** Session/identity/epoch ownership is checked on each side of every await. */
  readonly assertActive: () => void;
}
export class PublishedLoadError extends Error {
  readonly code = 'PUBLISHED_LOAD_FAILED';
  constructor() { super('The published napplet could not be verified'); this.name = 'PublishedLoadError'; }
}
const MAX_MANIFESTS = 32;
export const MAX_NAPPLET_HTML_BYTES = 2 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
function lookupRelay(value: unknown): string {
  try { return normalizeRelayUrl(value); } catch { throw new PublishedLoadError(); }
}
function active(options: PublishedLoadOptions): void {
  if (options.signal.aborted) throw new PublishedLoadError();
  try { options.assertActive(); } catch { throw new PublishedLoadError(); }
  if (options.signal.aborted) throw new PublishedLoadError();
}

/** Prepare a verified candidate. This function never opens a WebView or grants publisher trust. */
export async function loadPublishedArtifact(link: unknown, options: PublishedLoadOptions): Promise<VerifiedNappletArtifact> {
  const coordinate = resolveNappletLink(link);
  if (!Array.isArray(options.lookupRelays) || options.lookupRelays.length < 1 || options.lookupRelays.length > MAX_RELAYS_PER_ROLE ||
      (options.pinnedEventId !== undefined && !HEX64.test(options.pinnedEventId))) throw new PublishedLoadError();
  const relays = Object.freeze(options.lookupRelays.map(lookupRelay));
  if (new Set(relays).size !== relays.length) throw new PublishedLoadError();
  active(options);
  let candidates: readonly unknown[];
  try {
    const lookup = Object.freeze({ kind: coordinate.kind, pubkey: coordinate.pubkey, identifier: coordinate.identifier });
    candidates = await options.source.query(lookup, relays, options.pinnedEventId ?? null, options.signal);
  }
  catch { throw new PublishedLoadError(); }
  active(options);
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_MANIFESTS) throw new PublishedLoadError();
  const verified: VerifiedNappletManifest[] = [];
  const checks = await Promise.all(candidates.map(async (candidate) => {
    try { return await verifyManifest(coordinate, candidate); }
    catch { return null; }
  }));
  for (const manifest of checks) {
    if (manifest && (options.pinnedEventId === undefined || manifest.id === options.pinnedEventId)) verified.push(manifest);
  }
  if (verified.length === 0) throw new PublishedLoadError();
  verified.sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id));
  const chosen = verified[0]!;
  // Distinct valid replies at the same timestamp are ambiguous replaceable events.
  if (options.pinnedEventId === undefined && verified.some(candidate => candidate.created_at === chosen.created_at && candidate.id !== chosen.id)) {
    throw new PublishedLoadError();
  }
  active(options);
  let bytes: Uint8Array;
  try { bytes = await options.source.readHtml(chosen.expectedHtmlHash, chosen.serverHints, MAX_NAPPLET_HTML_BYTES, options.signal); }
  catch { throw new PublishedLoadError(); }
  active(options);
  const artifact = await verifyArtifact(chosen, bytes);
  active(options);
  return artifact;
}
