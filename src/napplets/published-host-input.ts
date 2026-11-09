import {captureLegacyReadOnly, LEGACY_READ_ONLY_PROFILE} from './legacy-read-only.ts';
import {appDataContextForArtifact} from '../app-data/app-data-source.ts';
import type { NappletDescriptor } from '../shell/workspace.ts';
import { assertVerifiedNappletAdmission, publishedCapabilityCompatibility, type VerifiedNappletAdmission } from './first-open-consent.ts';
import { assertVerifiedArtifact, type VerifiedNappletArtifact } from './verified-artifact.ts';
import {verifiedPublicationIdentity} from './verified-publication-identity.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE = /^[A-Za-z0-9-]{1,80}$/;

export class PublishedHostInputError extends Error {
  readonly code = 'PUBLISHED_HOST_INPUT_FAILED';
  constructor() { super('The published napplet session could not be prepared'); this.name = 'PublishedHostInputError'; }
}
const fail = (): never => { throw new PublishedHostInputError(); };

function claims(artifact: VerifiedNappletArtifact) {
  return { ...verifiedPublicationIdentity(artifact.manifest), publisher: artifact.manifest.pubkey, version: artifact.aggregateHash,
    eventId: artifact.manifest.eventId, htmlHash: artifact.htmlHash };
}

/** Create the exact durable pin only after signature and HTML verification. */
export function descriptorForPublishedArtifact(artifactInput: unknown, sessionId: string): NappletDescriptor {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  if (!SESSION.test(sessionId)) return fail();
  const verified = claims(artifact);
  return Object.freeze({ id: sessionId, title: verified.title, publisher: verified.publisher, appId: verified.appId,
    version: verified.version, source: 'published', eventId: verified.eventId });
}

/** Trusted app-only native prop: both hosts bind capabilities to the one-use artifact claim. */
export function publishedHostInput(artifactInput: unknown, admissionInput: unknown,
  descriptor: NappletDescriptor, authority: Readonly<{ user: string; epoch: number; assertActive(): void }>,
  handle: string, networkRelays: readonly string[] = []): string {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  assertVerifiedNappletAdmission(admissionInput, artifact);
  const admission: VerifiedNappletAdmission = admissionInput;
  try { authority.assertActive(); } catch { return fail(); }
  const verified = claims(artifact);
  if (!HEX64.test(authority.user) || !Number.isSafeInteger(authority.epoch) || authority.epoch < 0 ||
      !HANDLE.test(handle) || !SESSION.test(descriptor.id) || descriptor.source !== 'published' ||
      descriptor.publisher !== verified.publisher || descriptor.appId !== verified.appId ||
      descriptor.version !== verified.version || descriptor.eventId !== verified.eventId ||
      admission.publisher !== verified.publisher || admission.appId !== verified.appId ||
      admission.eventId !== verified.eventId) return fail();
  const domains = [...admission.domains].sort();
  const expected = publishedCapabilityCompatibility(artifact.manifest.requiredDomains,
    artifact.manifest.optionalDomains, admission.supportProfile).domains;
  if (domains.length !== expected.length || domains.some((domain, index) => domain !== expected[index])) return fail();
  const appData=appDataContextForArtifact(artifact,domains,networkRelays);
  if (descriptor.legacyReadOnly && (descriptor.legacyReadOnlyUser !== authority.user || verified.kind === 5129)) return fail();
  const legacyReadOnly = descriptor.legacyReadOnly === true ? captureLegacyReadOnly({
    profile: LEGACY_READ_ONLY_PROFILE, consent: true, eventId: verified.eventId, htmlHash: verified.htmlHash, relays: networkRelays,
  }, verified, domains) : undefined;
  const snapshot = verified.kind===5129 ? {snapshot:verified.snapshot} : {};
  const configuration = JSON.stringify({ sessionId: descriptor.id, epoch: authority.epoch,
    user: authority.user, publisher: verified.publisher, appId: verified.appId,
    version: verified.version, instanceId: descriptor.id, fixture: 'published', domains,...snapshot,...(legacyReadOnly?{legacyReadOnly}:{}),...(appData?{appData}:{}),...(admission.supportProfile==='current'&&domains.includes('media')?{mediaProfile:'finite-live-mp3-v1'}:{}),...(['current','before-live'].includes(admission.supportProfile)&&domains.includes('cvm')?{cvmProfile:'free-foreground-v1'}:{}),...(['current','before-live','before-cvm'].includes(admission.supportProfile)&&domains.includes('common')&&domains.includes('identity')&&domains.some(domain=>domain==='relay'||domain==='outbox')?{commonProfile:'social-v1'}:{}) });
  try { authority.assertActive(); } catch { return fail(); }
  admission.assertActive();
  return JSON.stringify({ sessionId: descriptor.id, publisher: verified.publisher, appId: verified.appId,
    eventId: verified.eventId, version: verified.version, htmlHash: verified.htmlHash, ...snapshot,handle, configuration });
}
