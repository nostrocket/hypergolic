import { normalizeRelayUrl } from '../network/relay-settings.ts';

export const LEGACY_READ_ONLY_PROFILE = 'legacy-read-only-v1' as const;
export type LegacyReadOnlyContext = Readonly<{profile: typeof LEGACY_READ_ONLY_PROFILE; consent: true;
  eventId: string; htmlHash: string; relays: readonly string[]}>;
type Pin = Readonly<{publisher: string; appId: string; eventId: string; version: string; htmlHash?: string}>;
const publisher = 'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20';
const pins = Object.freeze([
  {publisher, appId: 'recipe-cards', eventId: 'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07', version: '92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc', htmlHash: '9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194'},
  {publisher, appId: 'longform', eventId: '5fff2ec459ffb1a2d2966fc9815bc8ba45db96a669dfe4924d6c63e65b08a24e', version: '3ba5049444dd249abbe671f818d555b4e3c90b7cab88a70187bc3a012f9afd67', htmlHash: 'd5558df7e1f3823c0ad5c64273d57802fe304c1e2266bab8e5151fbf05ad51f4'},
]);
/** This first compatibility profile is reviewed per immutable publication. */
export function supportsLegacyReadOnly(pin: Pin): boolean {
  return pins.some(expected => expected.publisher === pin.publisher && expected.appId === pin.appId &&
    expected.eventId === pin.eventId && expected.version === pin.version &&
    (pin.htmlHash === undefined || expected.htmlHash === pin.htmlHash));
}
/** Used only after trusted native metadata or an explicit trusted shell decision. */
export function captureLegacyReadOnly(value: unknown, pin: Pin, domains: readonly string[]): LegacyReadOnlyContext {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !supportsLegacyReadOnly(pin) ||
      typeof pin.htmlHash !== 'string' || domains.length !== 0) throw new Error('Invalid legacy read-only source');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 5 || v.profile !== LEGACY_READ_ONLY_PROFILE || v.consent !== true ||
      v.eventId !== pin.eventId || v.htmlHash !== pin.htmlHash || !Array.isArray(v.relays) ||
      v.relays.length < 1 || v.relays.length > 16) throw new Error('Invalid legacy read-only consent');
  const relays = v.relays.map(relay => {
    const normalized = normalizeRelayUrl(relay);
    if (normalized !== relay || new URL(normalized).pathname !== '/') throw new Error('Invalid legacy relay');
    return normalized;
  });
  if (new Set(relays).size !== relays.length) throw new Error('Duplicate legacy relay');
  return Object.freeze({profile: LEGACY_READ_ONLY_PROFILE, consent: true, eventId: pin.eventId,
    htmlHash: pin.htmlHash, relays: Object.freeze(relays)});
}

/** A carried workspace cannot transfer another account's compatibility consent. */
export function isLegacyReadOnlySelection(descriptor: Readonly<{legacyReadOnly?: true; legacyReadOnlyUser?: string}>, user: string): boolean {
  return descriptor.legacyReadOnly === true && /^[0-9a-f]{64}$/.test(user) && descriptor.legacyReadOnlyUser === user;
}
