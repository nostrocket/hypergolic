import type { NappletDescriptor } from '../shell/workspace.ts';
import { assertVerifiedNappletAdmission, publishedCapabilityCompatibility, type VerifiedNappletAdmission } from './first-open-consent.ts';
import { assertVerifiedArtifact, type VerifiedNappletArtifact, type VerifiedNappletManifest } from './verified-artifact.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE = /^[A-Za-z0-9-]{1,80}$/;

export class PublishedHostInputError extends Error {
  readonly code = 'PUBLISHED_HOST_INPUT_FAILED';
  constructor() { super('The published napplet session could not be prepared'); this.name = 'PublishedHostInputError'; }
}
const fail = (): never => { throw new PublishedHostInputError(); };

function claims(artifact: VerifiedNappletArtifact): { publisher: string; appId: string; version: string; eventId: string; htmlHash: string } {
  const appId = artifact.manifest.tags.find(tag => tag[0] === 'd')?.[1];
  if (!appId) return fail();
  return { publisher: artifact.manifest.pubkey, appId, version: artifact.aggregateHash,
    eventId: artifact.manifest.eventId, htmlHash: artifact.htmlHash };
}

function boundedTitle(input: string): string {
  const clean = input.replace(/\s/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u206f\ud800-\udfff]/gu, '')
    .replace(/ +/g, ' ').trim();
  const encoder = new TextEncoder();
  let result = '', size = 0;
  for (const character of clean) {
    size += encoder.encode(character).byteLength;
    if (size > 128) break;
    result += character;
  }
  return result.trimEnd();
}

function publishedNappletTitle(manifest: VerifiedNappletManifest, appId: string): string {
  const titles = manifest.tags.filter(tag => tag[0] === 'title');
  const title = titles.length === 1 && titles[0]!.length === 2 ? boundedTitle(titles[0]![1]!) : '';
  return title || boundedTitle(appId) || 'Napplet';
}

/** Create the exact durable pin only after signature and HTML verification. */
export function descriptorForPublishedArtifact(artifactInput: unknown, sessionId: string): NappletDescriptor {
  assertVerifiedArtifact(artifactInput);
  const artifact: VerifiedNappletArtifact = artifactInput;
  if (!SESSION.test(sessionId)) return fail();
  const verified = claims(artifact);
  return Object.freeze({ id: sessionId, title: publishedNappletTitle(artifact.manifest, verified.appId), publisher: verified.publisher, appId: verified.appId,
    version: verified.version, source: 'published', eventId: verified.eventId });
}

/** Trusted app-only native prop: both hosts bind capabilities to the one-use artifact claim. */
export function publishedHostInput(artifactInput: unknown, admissionInput: unknown,
  descriptor: NappletDescriptor, authority: Readonly<{ user: string; epoch: number; assertActive(): void }>,
  handle: string): string {
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
  const configuration = JSON.stringify({ sessionId: descriptor.id, epoch: authority.epoch,
    user: authority.user, publisher: verified.publisher, appId: verified.appId,
    version: verified.version, instanceId: descriptor.id, fixture: 'published', domains,...(admission.supportProfile==='current'&&domains.includes('cvm')?{cvmProfile:'free-foreground-v1'}:{}),...(['current','before-cvm'].includes(admission.supportProfile)&&domains.includes('common')&&domains.includes('identity')&&domains.some(domain=>domain==='relay'||domain==='outbox')?{commonProfile:'social-v1'}:{}) });
  try { authority.assertActive(); } catch { return fail(); }
  admission.assertActive();
  return JSON.stringify({ sessionId: descriptor.id, publisher: verified.publisher, appId: verified.appId,
    eventId: verified.eventId, version: verified.version, htmlHash: verified.htmlHash, handle, configuration });
}
