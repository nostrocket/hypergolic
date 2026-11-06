import { SUPPORTED_CAPABILITY_DOMAINS } from './capability-protocol.ts';

export type SupportAvailability = 'available' | 'unavailable' | 'unknown';
// Bump when public availability, operations or limits change: this identifies reviewed support.
export const SUPPORT_PROFILE = 'hypergolic-native-2026-11-06-v1';
const INTENT_SUPPORT_PROFILE = 'hypergolic-native-2026-11-06-intent-v1';
const notes: Readonly<Record<string, string>> = Object.freeze({
  shell: 'Handshake and scoped discovery are implemented. Availability is not a full conformance assessment.',
  theme: 'Shell colours are delivered; the selected theme profile is bounded.',
  identity: 'Read-only public identity data; protected or encrypted data is unavailable.',
  storage: 'Scoped get, set, remove and keys; version and instance isolation apply.',
  relay: 'Bounded query, subscriptions and approved publication. Encrypted publication is unavailable.',
  resource: 'Bounded HTTPS, Blossom, one-hop Nostr and data bytes; selected audio/video playback. Hashtree, SVG and streaming are unavailable.',
  upload: 'Blossom only; selected files, metadata sanitation and approval for every upload.',
  link: 'Approved HTTPS links use the device handler. Other schemes are unavailable.',
  intent: 'Reviewed dispatch to installed napplets, including NIP-5D intent delivery. Uninstalled handler discovery is unavailable.',
  inc: 'Selected session-bound messages and channels; no background delivery.',
  notify: 'Foreground shell notifications. OS push is unavailable.',
  config: 'Selected bounded schemas and retained settings; unrestricted schema support is unavailable.',
  outbox: 'Selected bounded Outbox reads, subscriptions and approved publication for verified napplets. Operations also require the relay grant; final device E2E remains open.',
});

export function supportForDomain(domain: string): Readonly<{status: SupportAvailability; detail: string}> {
  const available = domain === 'shell' || SUPPORTED_CAPABILITY_DOMAINS.includes(domain);
  return Object.freeze({status: available ? 'available' : 'unavailable',
    detail: notes[domain] ?? 'This shell does not provide this NAP. No permission can enable it.'});
}

export function capabilityCompatibility(requested: readonly string[], available: readonly string[] = SUPPORTED_CAPABILITY_DOMAINS) {
  const offered = new Set(available);
  const domains = Object.freeze([...requested].filter(domain => offered.has(domain)).sort());
  const unsupportedDomains = Object.freeze([...requested].filter(domain => domain !== 'shell' && !offered.has(domain)).sort());
  const profile = requested.includes('intent') ? INTENT_SUPPORT_PROFILE : SUPPORT_PROFILE;
  return Object.freeze({domains, unsupportedDomains,
    review: JSON.stringify({profile, requested: [...requested].sort(), domains})});
}
