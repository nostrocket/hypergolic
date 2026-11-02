import { decode } from 'nostr-tools/nip19';

export type NappletCoordinate = Readonly<{
  kind: 35129;
  pubkey: string;
  identifier: string;
  /** Hints are validated but never used as lookup authority. */
  relayHints: readonly string[];
}>;

export class NappletLinkError extends Error {
  readonly code = 'INVALID_NAPPLET_LINK';
  constructor() { super('Invalid napplet link'); this.name = 'NappletLinkError'; }
}

const fail = (): never => { throw new NappletLinkError(); };
const HEX64 = /^[0-9a-f]{64}$/;
const DNS_LABEL = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const MAX_LINK_CHARS = 8192;
const MAX_IDENTIFIER_BYTES = 255;

function validPublicWssRelay(value: string): boolean {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' ||
      !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return false;
  return host.split('.').every(label => DNS_LABEL.test(label));
}

/** Accepts lowercase NIP-19 coordinates regardless of valid TLV field ordering. */
export function resolveNappletLink(input: unknown): NappletCoordinate {
  if (typeof input !== 'string' || input.length > MAX_LINK_CHARS) return fail();
  const encoded = input.startsWith('nostr:') ? input.slice(6) : input;
  if (!encoded.startsWith('naddr1') || encoded !== encoded.toLowerCase()) return fail();
  try {
    const decoded = decode(encoded);
    if (decoded.type !== 'naddr') return fail();
    const { kind, pubkey, identifier, relays = [] } = decoded.data;
    if (kind !== 35129 || !HEX64.test(pubkey) || typeof identifier !== 'string' || !identifier ||
        identifier.trim() !== identifier || /[\u0000-\u001f\u007f]/.test(identifier) ||
        new TextEncoder().encode(identifier).byteLength > MAX_IDENTIFIER_BYTES ||
        !Array.isArray(relays) || !relays.every(relay => typeof relay === 'string' && validPublicWssRelay(relay))) return fail();
    return Object.freeze({ kind: 35129, pubkey, identifier, relayHints: Object.freeze([...relays]) });
  } catch { return fail(); }
}
