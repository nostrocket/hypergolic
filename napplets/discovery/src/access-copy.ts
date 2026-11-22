const capabilityCopy = new Map<string, readonly [string, string]>([
  ['shell', ['Shell connection', 'Connect to the shell and check which capabilities are available.']],
  ['identity', ['Public profile', 'Read public information about the selected account.']],
  ['storage', ['App storage', 'Save data for this napplet under your selected identity.']],
  ['theme', ['Appearance', 'Follow the shell’s light or dark theme.']],
  ['relay', ['Nostr relays', 'Read events and ask to publish through your configured relays.']],
  ['resource', ['Resources', 'Request resources through the shell.']],
  ['upload', ['File uploads', 'Ask the shell to upload files you select.']],
  ['link', ['Links', 'Ask the shell to open a link.']],
  ['intent', ['Actions in other napplets', 'Ask another napplet to perform an action.']],
  ['inc', ['Messages between napplets', 'Exchange messages with other napplets.']],
  ['notify', ['Notifications', 'Request notifications from the shell.']],
  ['config', ['Settings', 'Use and request changes to settings for this napplet.']],
  ['outbox', ['Outbox routing', 'Read Nostr events or ask to publish using the relays associated with the accounts involved.']],
  ['keys', ['Keyboard shortcuts', 'Use hardware shortcuts while this napplet has focus.']],
  ['media', ['Media playback', 'Request media playback through the shell.']],
  ['cvm', ['External tools', 'Send requests to external tools through the shell.']],
  ['dm', ['Direct messages', 'Exchange private messages with other accounts.']],
  ['lists', ['Public and private lists', 'Request changes to lists supported by the shell.']],
  ['common', ['Nostr utilities', 'Use common Nostr tools. Profile lookup, public lists and social actions may need additional access.']],
]);


/** Publisher declarations are requests, never grants or proof of safety. */
export function accessCopy(domain: string) {
  const known = capabilityCopy.get(domain);
  return {name: known?.[0] ?? domain, description: known?.[1] ?? 'Unrecognized capability declared by the publisher.'};
}
