import { naddrEncode, neventEncode } from 'nostr-tools/nip19';
import { assertVerifiedArtifact, type VerifiedNappletArtifact } from './verified-artifact.ts';
import { verifiedPublicationIdentity } from './verified-publication-identity.ts';

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DISPLAY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u206f]/gu;

export type PublishedLaunchIcon = Readonly<{ hash: string; mime: string; serverHints: readonly string[] }>;
export type VerifiedLaunchMetadata = Readonly<{
  title: string;
  description: string;
  icon?: PublishedLaunchIcon;
  reference: string;
  version: string;
  htmlHash: string;
}>;

export function verifiedLaunchMetadata(artifact: VerifiedNappletArtifact): VerifiedLaunchMetadata {
  assertVerifiedArtifact(artifact);
  const { manifest, htmlHash, aggregateHash: version } = artifact;
  const { title, appId, kind } = verifiedPublicationIdentity(manifest);
  const reference = kind === 5129 ? neventEncode({ id: manifest.eventId, kind, author: manifest.pubkey })
    : naddrEncode({ kind, pubkey: manifest.pubkey, identifier: appId });
  const descriptions = manifest.tags.filter(tag => tag[0] === 'description');
  const [legacyDescription] = descriptions;
  const legacyText = descriptions.length === 1 && legacyDescription?.length === 2 ? legacyDescription[1]! : '';
  const description = (manifest.format === 'legacy-path' ? legacyText : manifest.content)
    .replace(DISPLAY_CONTROLS, '').trim().slice(0, 8192);
  const icons = manifest.tags.filter(tag => tag[0] === 'icon');
  const [icon] = icons;
  const artwork = icons.length === 1 && icon?.length === 3 && /^[0-9a-f]{64}$/.test(icon[1]!) && IMAGE_MIME_TYPES.has(icon[2]!)
    ? Object.freeze({ hash: icon[1]!, mime: icon[2]!, serverHints: manifest.serverHints }) : undefined;
  return Object.freeze({ title, description, ...(artwork && { icon: artwork }), reference, version, htmlHash });
}
