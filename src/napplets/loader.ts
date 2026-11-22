import type { NativePublishedBody } from './native-published-body.ts';
import { MAX_HTML_BYTES } from './artifact-limits.ts';
import { resolvePublishedReference, type NappletCoordinate, type NappletSnapshot } from './resolve-link.ts';
import { MAX_RELAYS_PER_ROLE, normalizeRelayUrl } from '../network/relay-settings.ts';
import { NappletHashMismatchError, NappletHtmlEnvelopeError, UnsupportedNappletManifestError, releasePublishedArtifact, verifyPublishedBody, verifyManifest,
  type VerifiedNappletArtifact, type VerifiedNappletManifest } from './verified-artifact.ts';

/** The source receives only the verified coordinate, never untrusted encoded relay hints. */
export type NappletLookupCoordinate = Pick<NappletCoordinate, 'kind' | 'pubkey' | 'identifier'> | NappletSnapshot;
/** Trusted transport hooks. Neither relay replies nor blob servers grant execution authority. */
export interface PublishedArtifactSource {
  query(coordinate: NappletLookupCoordinate, relays: readonly string[], pinnedEventId: string | null,
    signal: AbortSignal, discovery?: true): Promise<readonly unknown[]>;
  readHtml(expectedHash: string, serverHints: readonly string[], maxBytes: number,
    signal: AbortSignal): Promise<Uint8Array>;
  /** File-backed verification is available on the trusted native transport. */
  readVerifiedBody?(expectedHash: string, serverHints: readonly string[], maxBytes: number,
    signal: AbortSignal): Promise<NativePublishedBody>;
}
export interface PublishedLoadOptions {
  readonly source: PublishedArtifactSource;
  readonly lookupRelays: readonly string[];
  readonly signal: AbortSignal;
  /** Reopening an installed version must never substitute a newer or older event. */
  readonly pinnedEventId?: string;
  /** Owner-selected Network destinations for reviewed catalog opens with Network read authority. */
  readonly networkRelays?: readonly string[];
  /** Session/identity/epoch ownership is checked on each side of every await. */
  readonly assertActive: () => void;
}
type PublishedLoadCode = 'PUBLISHED_LOAD_FAILED' | 'PUBLISHED_NOT_FOUND' | 'PUBLISHED_PIN_CONFLICT' | 'PUBLISHED_UNSUPPORTED_MANIFEST' |
  'PUBLISHED_REVISION_CONFLICT' | 'PUBLISHED_LOOKUP_UNAVAILABLE' |
  'PUBLISHED_DOWNLOAD_UNAVAILABLE' | 'PUBLISHED_HASH_MISMATCH' | 'PUBLISHED_INVALID_HTML';

export class PublishedLoadError extends Error {
  readonly code: PublishedLoadCode;
  constructor(code: PublishedLoadCode = 'PUBLISHED_LOAD_FAILED') {
    super('The published napplet could not be verified'); this.name = 'PublishedLoadError'; this.code = code;
  }
}
const MAX_MANIFESTS = 32;
export const MAX_NAPPLET_HTML_BYTES = MAX_HTML_BYTES;
const HEX64 = /^[0-9a-f]{64}$/;
function lookupRelay(value: unknown): string {
  try { return normalizeRelayUrl(value); } catch { throw new PublishedLoadError(); }
}
function checkedRole(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > MAX_RELAYS_PER_ROLE) throw new PublishedLoadError();
  const relays = input.map(lookupRelay);
  if (new Set(relays).size !== relays.length) throw new PublishedLoadError();
  return relays;
}

type LoadAuthority = Pick<PublishedLoadOptions, 'source' | 'signal' | 'assertActive'>;

function active(options: LoadAuthority): void {
  if (options.signal.aborted) throw new PublishedLoadError();
  try { options.assertActive(); } catch { throw new PublishedLoadError(); }
  if (options.signal.aborted) throw new PublishedLoadError();
}

/** Resolve freshness and conflicting revisions before accessing any HTML. */
export async function resolvePublishedManifest(link: unknown, options: PublishedLoadOptions): Promise<VerifiedNappletManifest> {
  const coordinate = resolvePublishedReference(link);
  const discovery = options.networkRelays !== undefined;
  if ((options.pinnedEventId !== undefined && !HEX64.test(options.pinnedEventId)) ||
      (discovery && options.pinnedEventId !== undefined) ||
      (coordinate.kind === 5129 && (discovery || (options.pinnedEventId !== undefined && options.pinnedEventId !== coordinate.eventId)))) throw new PublishedLoadError();
  const relays = Object.freeze([...new Set([
    ...checkedRole(options.lookupRelays), ...checkedRole(options.networkRelays ?? []),
  ])]);
  if (relays.length === 0) throw new PublishedLoadError('PUBLISHED_LOOKUP_UNAVAILABLE');
  active(options);
  let candidates: readonly unknown[];
  try {
    const lookup = coordinate.kind === 5129 ? coordinate
      : Object.freeze({ kind: coordinate.kind, pubkey: coordinate.pubkey, identifier: coordinate.identifier });
    candidates = await options.source.query(lookup, relays, coordinate.kind === 5129 ? null : options.pinnedEventId ?? null,
      options.signal, discovery ? true : undefined);
  }
  catch { active(options); throw new PublishedLoadError('PUBLISHED_LOOKUP_UNAVAILABLE'); }
  active(options);
  if (!Array.isArray(candidates) || candidates.length > MAX_MANIFESTS) throw new PublishedLoadError('PUBLISHED_LOOKUP_UNAVAILABLE');
  if (candidates.length === 0) throw new PublishedLoadError('PUBLISHED_NOT_FOUND');
  const verified: VerifiedNappletManifest[] = [];
  const checks = await Promise.all(candidates.map(async candidate => {
    try { return await verifyManifest(coordinate, candidate); }
    catch (error) { return error instanceof UnsupportedNappletManifestError ? 'unsupported' : null; }
  }));
  active(options);
  for (const manifest of checks) {
    if (manifest && manifest !== 'unsupported' &&
        (options.pinnedEventId === undefined || manifest.id === options.pinnedEventId)) verified.push(manifest);
  }
  if (verified.length === 0) {
    throw new PublishedLoadError(checks.includes('unsupported') ? 'PUBLISHED_UNSUPPORTED_MANIFEST' : 'PUBLISHED_LOAD_FAILED');
  }
  verified.sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
  const chosen = verified[0]!;
  // Distinct valid replies at the same timestamp are ambiguous replaceable events.
  if (options.pinnedEventId === undefined && verified.some(candidate => candidate.created_at === chosen.created_at && candidate.id !== chosen.id)) {
    throw new PublishedLoadError('PUBLISHED_REVISION_CONFLICT');
  }
  return chosen;
}

export async function downloadPublishedArtifact(chosen: VerifiedNappletManifest, options: LoadAuthority): Promise<VerifiedNappletArtifact> {
  active(options);
  let body: Uint8Array | NativePublishedBody;
  try {
    const args = [chosen.expectedHtmlHash, chosen.serverHints, MAX_NAPPLET_HTML_BYTES, options.signal] as const;
    body = options.source.readVerifiedBody ? await options.source.readVerifiedBody(...args) : await options.source.readHtml(...args);
  }
  catch (error) {
    active(options);
    if (error instanceof NappletHtmlEnvelopeError) throw new PublishedLoadError('PUBLISHED_INVALID_HTML');
    throw new PublishedLoadError(error instanceof NappletHashMismatchError ? 'PUBLISHED_HASH_MISMATCH' : 'PUBLISHED_DOWNLOAD_UNAVAILABLE');
  }
  let artifact: VerifiedNappletArtifact | undefined;
  try {
    active(options);
    artifact = await verifyPublishedBody(chosen, body);
    active(options);
    return artifact;
  }
  catch (error) {
    if (artifact) releasePublishedArtifact(artifact);
    else if (!(body instanceof Uint8Array)) body.dispose();
    active(options);
    if (error instanceof NappletHashMismatchError) throw new PublishedLoadError('PUBLISHED_HASH_MISMATCH');
    if (error instanceof NappletHtmlEnvelopeError) throw new PublishedLoadError('PUBLISHED_INVALID_HTML');
    throw error;
  }
}

/** Prepare a verified candidate without grants or WebView side effects. */
export async function loadPublishedArtifact(link: unknown, options: PublishedLoadOptions): Promise<VerifiedNappletArtifact> {
  return downloadPublishedArtifact(await resolvePublishedManifest(link, options), options);
}
