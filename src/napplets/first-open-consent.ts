import { ReviewBusyError } from '../shell/review-slot.ts';
import { assertVerifiedArtifact, type VerifiedNappletArtifact } from './verified-artifact.ts';
import type { AppStorageControl } from '../storage/database.ts';
import type { TrustedApp } from '../storage/ports.ts';
import { reviewedCapabilityCompatibility, type ReviewedSupportProfile } from '../runtime/support-report.ts';
import {verifiedPublicationIdentity} from './verified-publication-identity.ts';
import { verifiedLaunchMetadata, type VerifiedLaunchMetadata } from './verified-launch-metadata.ts';
import type {SnapshotIdentity} from './published-identity.ts';

export class FirstOpenConsentError extends Error {
  readonly code = 'NAPPLET_CONSENT_DENIED';
  constructor() { super('Napplet access was not approved'); this.name = 'FirstOpenConsentError'; }
}

export type NappletConsentReview = Readonly<{
  user: string;
  publisher: string;
  appId: string;
  eventId: string;
  metadata: VerifiedLaunchMetadata;
  snapshot?: SnapshotIdentity;
  domains: readonly string[];
  unsupportedDomains: readonly string[];
  optionalDomains: readonly string[];
  unsupportedOptionalDomains: readonly string[];
}>;

export type VerifiedNappletAdmission = Readonly<{
  publisher: string;
  appId: string;
  eventId: string;
  domains: readonly string[];
  supportProfile: ReviewedSupportProfile;
  assertActive(): void;
}>;

const admissions = new WeakSet<object>();
const fail = (): never => { throw new FirstOpenConsentError(); };

function active(signal: AbortSignal, owner: TrustedApp, identity: Readonly<{ user: string; publisher: string; appId: string; check: () => void }>, assertActive: () => void): void {
  if (signal.aborted) return fail();
  try {
    if (owner.user !== identity.user || owner.publisher !== identity.publisher || owner.appId !== identity.appId || owner.assertActive !== identity.check) return fail();
    identity.check(); assertActive();
  } catch { return fail(); }
  if (signal.aborted) return fail();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Keep the single-set grant format for publications without optional domains. */
export function publishedCapabilityCompatibility(required: readonly string[], optional: readonly string[],
  profile: ReviewedSupportProfile = 'current') {
  const combined=Object.freeze([...required,...optional]);
  const requiredSupport = reviewedCapabilityCompatibility(required, profile,combined);
  const optionalSupport = reviewedCapabilityCompatibility(optional, profile,combined);
  const grantedDomains = Object.freeze([...requiredSupport.domains, ...optionalSupport.domains].sort());
  const domains = profile === 'legacy' && !grantedDomains.includes('relay')
    ? Object.freeze(grantedDomains.filter(domain => domain !== 'outbox')) : grantedDomains;
  return Object.freeze({
    domains, grantedDomains,
    unsupportedDomains: requiredSupport.unsupportedDomains,
    unsupportedOptionalDomains: optionalSupport.unsupportedDomains,
    review: optional.length ? JSON.stringify([requiredSupport.review, optionalSupport.review]) : requiredSupport.review,
  });
}

/**
 * Admit a verifier-branded published artifact only after a trusted shell review
 * has accepted the exact publisher, signed d coordinate, and requested NAP capabilities.
 * A revision conflict is deliberately a denial; the caller must start a fresh review.
 */
export async function requestFirstOpenConsent(
  artifactInput: unknown,
  owner: TrustedApp,
  storage: Pick<AppStorageControl, 'readAccessGrant' | 'replaceAccessGrant'>,
  signal: AbortSignal,
  assertActive: () => void,
  review: (request: NappletConsentReview) => Promise<boolean>,
  mode: 'review' | 'saved-pin' = 'review',
): Promise<VerifiedNappletAdmission> {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  const publication = verifiedPublicationIdentity(artifact.manifest);
  const publisher = artifact.manifest.pubkey;
  const eventId = artifact.manifest.eventId;
  const user = owner.user;
  const ownerPublisher = owner.publisher;
  const appId = owner.appId;
  const ownerCheck = owner.assertActive;
  if (typeof ownerCheck !== 'function' || publisher !== ownerPublisher || appId !== publication.appId ||
      typeof user !== 'string' || typeof appId !== 'string') return fail();
  const requestedDomains = Object.freeze([...artifact.manifest.requiredDomains].sort());
  const optionalDomains = Object.freeze([...artifact.manifest.optionalDomains].sort());
  const {domains, unsupportedDomains, unsupportedOptionalDomains, review: supportReview} =
    publishedCapabilityCompatibility(requestedDomains, optionalDomains);
  const identity = Object.freeze({ user, publisher: ownerPublisher, appId, check: ownerCheck });
  active(signal, owner, identity, assertActive);

  let current;
  try {
    current = await storage.readAccessGrant({ signal });
  } catch { return fail(); }
  active(signal, owner, identity, assertActive);
  const existing = current ? [...current.domains].sort() : [];
  let accepted: Readonly<{domains: readonly string[]; supportProfile: ReviewedSupportProfile}> | undefined;
  if (current?.supportReview === supportReview && sameSet(existing, domains)) {
    accepted = { domains, supportProfile: 'current' };
  } else {
    for (const profile of ['before-live','before-cvm','before-social','before-common','legacy'] as const) {
      const previous = publishedCapabilityCompatibility(requestedDomains, optionalDomains, profile);
      if (current?.supportReview === previous.review && sameSet(existing, previous.grantedDomains) &&
          (mode === 'saved-pin' || !domains.includes('media') && (!domains.includes('common') || !domains.includes('identity') || !domains.some(domain=>domain==='relay'||domain==='outbox')) && sameSet(previous.domains, domains))) {
        accepted = { domains: previous.domains, supportProfile: profile };
        break;
      }
    }
  }

  if (!accepted) {
    const request = Object.freeze({ user, publisher, appId, eventId, metadata: verifiedLaunchMetadata(artifact), ...(publication.kind===5129?{snapshot:publication.snapshot}:{}),
      domains: requestedDomains, unsupportedDomains,
      optionalDomains, unsupportedOptionalDomains });
    let approved = false;
    try { approved = await review(request) === true; }
    catch (error) { if (error instanceof ReviewBusyError) throw error; return fail(); }
    active(signal, owner, identity, assertActive);
    if (!approved) return fail();
    try {
      await storage.replaceAccessGrant(domains, current?.revision ?? null, { signal }, supportReview);
    } catch { return fail(); }
    active(signal, owner, identity, assertActive);
    accepted = { domains, supportProfile: 'current' };
  }

  const assertAdmissionActive = (): void => active(signal, owner, identity, assertActive);
  const admission = Object.freeze({ publisher, appId, eventId, ...accepted, assertActive: assertAdmissionActive });
  admissions.add(admission);
  assertAdmissionActive();
  return admission;
}

/** Validate admission provenance and keep the session/identity revocation check live. */
export function assertVerifiedNappletAdmission(
  admission: unknown,
  artifactInput: unknown,
): asserts admission is VerifiedNappletAdmission {
  if (typeof admission !== 'object' || admission === null || !admissions.has(admission)) return fail();
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  const verified = admission as VerifiedNappletAdmission;
  const expected = publishedCapabilityCompatibility(artifact.manifest.requiredDomains,
    artifact.manifest.optionalDomains, verified.supportProfile).domains;
  if (verified.publisher !== artifact.manifest.pubkey || verified.appId !== verifiedPublicationIdentity(artifact.manifest).appId ||
      verified.eventId !== artifact.manifest.eventId || !sameSet(verified.domains, expected)) return fail();
  verified.assertActive();
}
