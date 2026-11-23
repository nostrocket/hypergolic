import type { PublishedLaunchIcon } from '../napplets/verified-launch-metadata.ts';

/** Stored artwork is a bounded content-addressed hint, never an arbitrary image URI. */
export function pinArtwork(value: unknown): PublishedLaunchIcon | undefined {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid artwork');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 3 || ['hash', 'mime', 'serverHints'].some(key => !fields[key] || !Object.hasOwn(fields[key], 'value'))) throw new Error('Invalid artwork');
  const {hash, mime, serverHints} = value as PublishedLaunchIcon;
  if (typeof hash !== 'string' || typeof mime !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) ||
      !Array.isArray(serverHints) || serverHints.length > 16 || serverHints.some(hint => typeof hint !== 'string' || hint.length > 2048 || !hint.startsWith('https://'))) throw new Error('Invalid artwork');
  if (mime === 'image/gif') return undefined; // Keep the saved pin and discard its obsolete artwork.
  return Object.freeze({hash, mime, serverHints: Object.freeze([...serverHints])});
}
