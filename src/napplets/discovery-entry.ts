import type { NappletDescriptor } from '../shell/workspace.ts';
import { resolveBundledSession } from '../shell/fixtures.ts';
import { resolveNappletLink, type NappletCoordinate } from './resolve-link.ts';
import { DISCOVERY_PUBLICATION_ADDRESS } from './discovery-publication.ts';

export function discoveryCoordinate(address: string | null = DISCOVERY_PUBLICATION_ADDRESS): NappletCoordinate | null {
  if (address === null) return null;
  const coordinate = resolveNappletLink(address);
  if (address.startsWith('nostr:') || coordinate.relayHints.length !== 0) throw new Error('Invalid discovery publication configuration');
  return coordinate;
}

/** Metadata is an eligibility check only; runtime and native owners verify the artifact. */
export function isDiscoveryEntry(session: NappletDescriptor, address: string | null = DISCOVERY_PUBLICATION_ADDRESS): boolean {
  if (session.source === 'bundled') {
    try { return resolveBundledSession(session).fixture === 'napplet-discovery'; } catch { return false; }
  }
  const coordinate = discoveryCoordinate(address);
  return coordinate !== null && session.publisher === coordinate.pubkey && session.appId === coordinate.identifier &&
    /^[0-9a-f]{64}$/.test(session.eventId ?? '') && /^[0-9a-f]{64}$/.test(session.version);
}
