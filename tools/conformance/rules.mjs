import {componentCases} from './component-cases.mjs';

// Stable IDs identify individual observations. An issue may cover additional requirements.
export const rules = [
  ...componentCases.map(([id, domain, , name]) => [id, domain === 'NIP-5D' ? domain : 'NAP-' + domain, '', name]),
  ['keys-registration', 'NAP-KEYS', 'wire-protocol', 'Acknowledge a registered keyboard action'],
  ['media-destroy', 'NAP-MEDIA', 'wire-protocol', 'Preserve the target session when requesting playback teardown'],
  ['modern-manifest', 'NIP-5D', 'identity', 'Open a signed single-hash manifest'],
  ['artifact-integrity', 'NIP-5D', 'identity', 'Reject changed artifact bytes'],
  ['legacy-manifest', 'NIP-5D', 'manifest', 'Require the x tag on a legacy-shaped named manifest', 104],
  ['launch-icon-format', 'NIP-5D', 'icon', 'Use generic launch artwork for an unsupported GIF icon'],
  ['inc-peer', 'NAP-INC', 'schemas', 'Distinguish two running instances of the same named application'],
  ['relay-continuity', 'NAP-RELAY', 'shell-behavior', 'Continue a public feed past an unsupported encrypted event'],
  ['config-default', 'NAP-CONFIG', 'core-subset', 'Follow a changed default until the user saves a value'],
  ['config-user-choice', 'NAP-CONFIG', 'core-subset', 'Retain an explicitly saved setting across default changes'],
  ['identity-connected', 'NAP-IDENTITY', 'shell-behavior', 'Keep a transient owner failure distinct from sign-out'],
  ['intent-action', 'NAP-INTENT', 'wire-protocol', 'Require an explicit action in a normalized invocation'],
  ['theme-reply', 'NAP-THEME', 'error-handling', 'Return the correlated Theme result on quota refusal'],
  ['cleartext-publication', 'NIP-5D', 'security-considerations', 'Refuse encrypted Relay and Outbox requests before review'],
  ...['chromium', 'webkit'].flatMap(engine => [
    [engine + '-environment', 'NAP-SHELL', 'api-surface', engine + ' exposes the granted Theme service through its shell environment'],
    [engine + '-sandbox', 'NIP-5D', 'transport', engine + ' uses the scripts-only iframe sandbox'],
    [engine + '-srcdoc', 'NIP-5D', 'identity', engine + ' mounts the fixture with srcdoc'],
    [engine + '-hello', 'NIP-5D', 'transport', engine + ' transfers one port and carries startup NAP traffic off the window', 98],
  ]),
].map(([id, spec, section, title, issue]) => ({id, spec, section, title, issue}));
