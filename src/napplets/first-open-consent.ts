import { assertVerifiedArtifact, type VerifiedNappletArtifact } from './verified-artifact.ts';
import type { AppStorageControl } from '../storage/database.ts';
import type { TrustedApp } from '../storage/ports.ts';
import { capabilityCompatibility } from '../runtime/support-report.ts';

export class FirstOpenConsentError extends Error {
  readonly code = 'NAPPLET_CONSENT_DENIED';
  constructor() { super('Napplet access was not approved'); this.name = 'FirstOpenConsentError'; }
}

export type NappletConsentReview = Readonly<{
  user: string;
  publisher: string;
  appId: string;
  eventId: string;
  domains: readonly string[];
  unsupportedDomains: readonly string[];
}>;

export type VerifiedNappletAdmission = Readonly<{
  publisher: string;
  appId: string;
  eventId: string;
  domains: readonly string[];
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

function exactIdentifier(artifact: VerifiedNappletArtifact): string {
  const tags = artifact.manifest.tags;
  const dTags = tags.filter(tag => tag[0] === 'd');
  if (dTags.length !== 1 || dTags[0]!.length !== 2 || !dTags[0]![1]) return fail();
  return dTags[0]![1]!;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Admit a verifier-branded published artifact only after a trusted shell review
 * has accepted the exact publisher, signed d coordinate, and required NAP capabilities.
 * A revision conflict is deliberately a denial; the caller must start a fresh review.
 */
export async function requestFirstOpenConsent(
  artifactInput: unknown,
  owner: TrustedApp,
  storage: Pick<AppStorageControl, 'readAccessGrant' | 'replaceAccessGrant'>,
  signal: AbortSignal,
  assertActive: () => void,
  review: (request: NappletConsentReview) => Promise<boolean>,
): Promise<VerifiedNappletAdmission> {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  const identifier = exactIdentifier(artifact);
  const publisher = artifact.manifest.pubkey;
  const eventId = artifact.manifest.eventId;
  const user = owner.user;
  const ownerPublisher = owner.publisher;
  const appId = owner.appId;
  const ownerCheck = owner.assertActive;
  if (typeof ownerCheck !== 'function' || publisher !== ownerPublisher || appId !== identifier ||
      typeof user !== 'string' || typeof appId !== 'string') return fail();
  const requestedDomains = Object.freeze([...artifact.manifest.requiredDomains].sort());
  const {domains, unsupportedDomains, review: supportReview} = capabilityCompatibility(requestedDomains);
  const identity = Object.freeze({ user, publisher: ownerPublisher, appId, check: ownerCheck });
  active(signal, owner, identity, assertActive);

  let current;
  try {
    current = await storage.readAccessGrant({ signal });
  } catch { return fail(); }
  active(signal, owner, identity, assertActive);
  const existing = current ? [...current.domains].sort() : null;
  let admitted = current !== null && existing !== null && sameSet(existing, domains) && current.supportReview === supportReview;

  if (!admitted) {
    const request = Object.freeze({ user, publisher, appId, eventId, domains: requestedDomains, unsupportedDomains });
    let approved = false;
    try { approved = await review(request) === true; }
    catch { return fail(); }
    active(signal, owner, identity, assertActive);
    if (!approved) return fail();
    try {
      await storage.replaceAccessGrant(domains, current?.revision ?? null, { signal }, supportReview);
    } catch { return fail(); }
    active(signal, owner, identity, assertActive);
    admitted = true;
  }

  if (!admitted) return fail();
  const assertAdmissionActive = (): void => active(signal, owner, identity, assertActive);
  const admission = Object.freeze({ publisher, appId, eventId, domains, assertActive: assertAdmissionActive });
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
  if (verified.publisher !== artifact.manifest.pubkey || verified.appId !== exactIdentifier(artifact) ||
      verified.eventId !== artifact.manifest.eventId || !sameSet(verified.domains, capabilityCompatibility(artifact.manifest.requiredDomains).domains)) return fail();
  verified.assertActive();
}
