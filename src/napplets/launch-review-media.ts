import { base64 } from '@scure/base';
import type { TrustedIdentityDataPort } from '../identity/identity-service.ts';
import type { ProfileAvatarReader } from '../identity/profile-avatar-image.ts';
import { classifyResourceBytes } from '../resources/resource-mime.ts';
import type { PublishedArtifactSource } from './loader.ts';
import type { PublishedLaunchIcon } from './verified-launch-metadata.ts';

export type LaunchReviewMedia = Readonly<{
  readProfile: TrustedIdentityDataPort['readProfile'];
  readAvatar: ProfileAvatarReader;
  readIcon(icon: PublishedLaunchIcon, signal: AbortSignal): Promise<string>;
}>;

const MAX_ICON_BYTES = 768 * 1024;

export function createLaunchReviewMedia(profiles: Pick<TrustedIdentityDataPort, 'readProfile'>, readAvatar: ProfileAvatarReader,
  blobs: Pick<PublishedArtifactSource, 'readHtml'>, servers: () => readonly string[]): LaunchReviewMedia {
  // Each URI is bounded by MAX_ICON_BYTES. Retain at most eight per identity owner.
  const icons = new Map<string, string>();
  return Object.freeze({
    readProfile: profiles.readProfile,
    readAvatar,
    async readIcon(icon: PublishedLaunchIcon, signal: AbortSignal) {
      if (signal.aborted) throw new Error('Icon unavailable');
      const key = icon.mime + ':' + icon.hash;
      const hit = icons.get(key);
      if (hit) {
        icons.delete(key);
        icons.set(key, hit);
        return hit;
      }
      const mirrors = [...new Set([...icon.serverHints, ...servers()])];
      // The published transport bounds the read and verifies the signed Blossom hash.
      const bytes = await blobs.readHtml(icon.hash, mirrors, MAX_ICON_BYTES, signal);
      if (signal.aborted || classifyResourceBytes(bytes) !== icon.mime) throw new Error('Icon unavailable');
      const uri = `data:${icon.mime};base64,${base64.encode(bytes)}`;
      icons.set(key, uri);
      if (icons.size > 8) icons.delete(icons.keys().next().value!);
      return uri;
    },
  });
}
