import {boundedPublishedTitle,snapshotAppKey,type SnapshotIdentity} from './published-identity.ts';
import type {VerifiedNappletManifest} from './verified-artifact.ts';

export type VerifiedPublicationIdentity =
  | Readonly<{kind:35129;appId:string;title:string}>
  | Readonly<{kind:5129;appId:string;title:string;snapshot:SnapshotIdentity}>;

/** The exact event was already verified when this manifest was created. */
export function verifiedPublicationIdentity(manifest: VerifiedNappletManifest): VerifiedPublicationIdentity {
  const titles = manifest.tags.filter(tag => tag[0] === 'title');
  const title = titles.length === 1 && titles[0]!.length === 2 ? boundedPublishedTitle(titles[0]![1]!) : '';
  if (manifest.kind === 5129) {
    const snapshot = Object.freeze({kind:5129 as const,eventId:manifest.eventId,title:title || 'Published snapshot'});
    return Object.freeze({kind:5129,appId:snapshotAppKey(snapshot.eventId),title:snapshot.title,snapshot});
  }
  const appId = manifest.tags.find(tag => tag[0] === 'd')?.[1];
  if (!appId) throw new Error('Invalid published identifier');
  return Object.freeze({kind:35129,appId,title:title || boundedPublishedTitle(appId) || 'Napplet'});
}
