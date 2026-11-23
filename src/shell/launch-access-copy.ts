import {publishedAppLabel} from '../napplets/published-identity.ts';
import { MEDIA_ACCESS_DETAIL } from '../runtime/support-report.ts';

export const LEGACY_MANIFEST_NOTICE = 'This release uses an older publication format. Hypergolic verified its signature and checked its HTML against the hash in the signed file listing. Opening it uses legacy compatibility.';

const capabilityCopy = new Map<string, readonly [string, string]>([
  ['shell', ['Shell connection', 'Connect to Hypergolic and check which capabilities are available.']],
  ['lists', ['Public recommendations', 'Ask to add an app to your public recommendations. You review the app and relays before publishing.']],
  ['identity', ['Public profile', 'Read your public account information. Some public lists need separate approval.']],
  ['storage', ['App storage', 'Save data for this napplet under your selected identity.']],
  ['theme', ['Appearance', 'Follow Hypergolic’s light or dark theme.']],
  ['relay', ['Nostr relays', 'Read events and ask to publish through your configured relays.']],
  ['resource', ['Resources', 'Download bounded public resources through Hypergolic. Files stay in memory while this napplet is open.']],
  ['upload', ['File uploads', 'Ask to upload files you choose to Blossom. Each upload needs your approval.']],
  ['link', ['Open links', 'Ask to open web pages or review a published napplet.']],
  ['intent', ['Actions in other napplets', 'Ask an installed napplet to perform an action. Each dispatch needs your approval.']],
  ['inc', ['Messages between napplets', 'Exchange messages with approved peers while Hypergolic is in the foreground.']],
  ['notify', ['Notifications', 'Show notifications inside Hypergolic.']],
  ['config', ['Settings', 'Use and request changes to this napplet’s settings in Hypergolic.']],
  ['outbox', ['Outbox routing', 'Read Nostr events or ask to publish using the relays associated with the accounts involved.']],
  ['keys', ['Keyboard shortcuts', 'Use hardware shortcuts while this napplet has focus.']],
  ['media', ['Media playback', MEDIA_ACCESS_DETAIL]],
  ['cvm', ['External tools', 'Ask to send encrypted requests to free tools. Hypergolic asks you to review the provider and what is sent.']],
  ['dm', ['Direct messages', 'Exchange private messages with other accounts.']],
  ['common', ['Nostr utilities', 'Use common Nostr tools. Profile lookup, public lists and social actions may need additional access.']],
]);


/** Publisher declarations are requests, never grants or proof of safety. */
export function launchAccessCopy(domain: string, unavailable: boolean) {
  const known = capabilityCopy.get(domain);
  return { name: known?.[0] ?? `Unrecognized capability · ${publishedAppLabel(domain)}`, description: unavailable
    ? 'Unavailable in Hypergolic. This access will not be granted; features that need it will not work.'
    : known?.[1] ?? 'Unrecognized capability declared by the publisher. Availability and behavior are not confirmed.' };
}
