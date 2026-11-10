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
  return Object.freeze({
    readProfile: profiles.readProfile,
    readAvatar,
    async readIcon(icon: PublishedLaunchIcon, signal: AbortSignal) {
      const mirrors = [...new Set([...icon.serverHints, ...servers()])];
      // The published transport bounds the read and verifies the signed Blossom hash.
      const bytes = await blobs.readHtml(icon.hash, mirrors, MAX_ICON_BYTES, signal);
      if (signal.aborted || classifyResourceBytes(bytes) !== icon.mime) throw new Error('Icon unavailable');
      return `data:${icon.mime};base64,${base64.encode(bytes)}`;
    },
  });
}
