import { SUPPORTED_CAPABILITY_DOMAINS } from './capability-protocol.ts';

export type SupportAvailability = 'available' | 'unavailable' | 'unknown';
// Bump when public availability, operations or limits change: this identifies reviewed support.
const PROFILE_PREFIX = 'hypergolic-native-2026-11-06';
const BASE_SUPPORT_PROFILE = `${PROFILE_PREFIX}-v1`;
const INTENT_SUPPORT_PROFILE = 'hypergolic-native-2026-11-06-intent-v1';
export const MEDIA_ACCESS_DETAIL = 'Media access lets this napplet offer a public HTTPS video. Play in the shell authorizes playback and a download of up to 256 MiB for the selected video. The source may redirect to another public HTTPS site.';
const MEDIA_SUPPORT_PROFILE = `${PROFILE_PREFIX}-media-file-v1`;
const COMMON_SOCIAL_SUPPORT_PROFILE=`${PROFILE_PREFIX}-common-social-v1`;
const CVM_SUPPORT_PROFILE=`${PROFILE_PREFIX}-cvm-free-foreground-v1`;
export const REPORTED_SUPPORT_PROFILE = `${PROFILE_PREFIX}-outbox-keys-v1/${MEDIA_SUPPORT_PROFILE}/${PROFILE_PREFIX}-common-read-v1/${COMMON_SOCIAL_SUPPORT_PROFILE}/${CVM_SUPPORT_PROFILE}`;
export type ReviewedSupportProfile = 'current' | 'before-cvm' | 'before-social' | 'before-common' | 'legacy';
const beforeCommonDomains = Object.freeze(SUPPORTED_CAPABILITY_DOMAINS.filter(domain => domain !== 'common' && domain !== 'cvm'));
const legacyDomains = Object.freeze(['identity', 'storage', 'theme', 'relay', 'resource', 'upload',
  'link', 'intent', 'inc', 'notify', 'config', 'outbox']);

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
  outbox: 'Outbox queries return up to 200 events. Bounded subscriptions and approved publication are available. Raw Relay operations require a separate grant.',
  keys: 'Hardware keyboard actions for the focused napplet. Ordinary suggested shortcuts can work outside text entry.',
  media: 'Shell-owned foreground HTTPS MP4 playback after trusted Play. Live streams, playlists and napplet-owned sessions are unavailable.',
  cvm: 'Encrypted free-only MCP requests after exact provider, arguments and foreground service review. Up to 2 minutes; no shell payments. Another card may be used while the source napplet stays open. Discovery and registry execution are unavailable.',
  common: 'Public NIP-19 helpers. Profile lookup needs a Relay or Outbox grant; follows needs Identity. Social writes need renewed Common access, Identity and Relay or Outbox, a selected signing method and exact event approval. Follow replacements are bounded by the existing 8 KiB publication frame.',
});

export function supportForDomain(domain: string): Readonly<{status: SupportAvailability; detail: string}> {
  const available = domain === 'shell' || SUPPORTED_CAPABILITY_DOMAINS.includes(domain);
  return Object.freeze({status: available ? 'available' : 'unavailable',
    detail: notes[domain] ?? 'This shell does not provide this NAP. No permission can enable it.'});
}

function supportProfile(requested: readonly string[], policy: ReviewedSupportProfile,granted:readonly string[]): string {
  const intent = requested.includes('intent');
  const previous = intent ? INTENT_SUPPORT_PROFILE : BASE_SUPPORT_PROFILE;
  if (policy === 'legacy') return previous;
  const added = ['outbox', 'keys'].filter(domain => requested.includes(domain));
  if (intent && added.length) added.push('intent');
  const profile = added.length ? `${PROFILE_PREFIX}-${added.join('-')}-v1` : previous;
  const media = requested.includes('media') ? `${profile}/${MEDIA_SUPPORT_PROFILE}` : profile;
  const read=policy!=='before-common'&&requested.includes('common')?`${media}/${PROFILE_PREFIX}-common-read-v1`:media;
  const social=granted.includes('common')&&granted.includes('identity')&&(granted.includes('relay')||granted.includes('outbox'));
  const selected=(policy==='current'||policy==='before-cvm')&&social&&requested.includes('common')?`${read}/${COMMON_SOCIAL_SUPPORT_PROFILE}`:read;
  return policy==='current'&&requested.includes('cvm')&&granted.includes('cvm')?`${selected}/${CVM_SUPPORT_PROFILE}`:selected;
}

export function capabilityCompatibility(requested: readonly string[], available: readonly string[] = SUPPORTED_CAPABILITY_DOMAINS,
  policy: ReviewedSupportProfile = 'current',combinedRequested:readonly string[]=requested) {
  const offered = new Set(available);
  const domains = Object.freeze([...requested].filter(domain => offered.has(domain)).sort());
  const unsupportedDomains = Object.freeze([...requested].filter(domain => domain !== 'shell' && !offered.has(domain)).sort());
  const profile = supportProfile(requested, policy,combinedRequested.filter(domain=>offered.has(domain)));
  return Object.freeze({domains, unsupportedDomains,
    review: JSON.stringify({profile, requested: [...requested].sort(), domains})});
}

export function reviewedCapabilityCompatibility(requested: readonly string[], policy: ReviewedSupportProfile,combinedRequested:readonly string[]=requested) {
  const available = policy === 'legacy' ? legacyDomains : policy === 'before-common' ? beforeCommonDomains : policy==='current'?SUPPORTED_CAPABILITY_DOMAINS:SUPPORTED_CAPABILITY_DOMAINS.filter(domain=>domain!=='cvm');
  return capabilityCompatibility(requested, available, policy,combinedRequested);
}
