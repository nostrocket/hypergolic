import { emptyWorkspace, focusNapplet, openNapplet, type NappletDescriptor, type Workspace } from './workspace.ts';
import { BUNDLED_FIXTURES, type BundledFixture } from '../runtime/bundled-catalog.ts';

export type BundledVariant = Exclude<BundledFixture, 'approval-lab-v1' | 'approval-lab-v2' | 'approval-lab-v3' | 'feed-lab-v1'> | 'state-lab-other-publisher';
const variants: readonly BundledVariant[] = ['close-lab', 'nap-support', 'routing-lab-peer', 'routing-lab', 'upload-lab', 'state-lab-other-publisher', 'resource-lab', 'feed-lab', 'approval-lab', 'state-lab-peer', 'state-lab', 'ux-lab'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Exact previous stateless Support fixture, with the same link/theme authority.
// Retained descriptors load current hash-verified packaged bytes; no remote pin is relaxed.
const previousSupportVersion = 'd580bdedb19857d66a4b5f2928016c3f756960f42e56f7d98f8fb98df90f1653';
export function bundledDescriptor(variant: BundledVariant, number: number, instance = String(number)): NappletDescriptor {
  const fixture = variant === 'state-lab-other-publisher' ? 'state-lab' : variant;
  const entry = BUNDLED_FIXTURES[fixture];
  const alternate = variant === 'state-lab-other-publisher';
  return { id: `${variant}-${instance}`, title: `${alternate ? 'State Lab Other Publisher' : entry.title} ${number}`,
    publisher: alternate ? 'bundled-unsigned-peer' : 'bundled-unsigned-fixture', appId: entry.appId,
    // Preserve already-saved UX Lab descriptors; privileged namespaces use the aggregate below.
    version: fixture === 'ux-lab' ? entry.sha256 : entry.aggregateHash, source: 'bundled' };
}
export function bundledUXDescriptor(number: number): NappletDescriptor { return bundledDescriptor('ux-lab', number); }
export function initialTestWorkspace(): Workspace {
  const loaded = [1, 2, 3].reduce((state, number) => openNapplet(state, bundledUXDescriptor(number)), emptyWorkspace());
  return focusNapplet(loaded, 'ux-lab-1');
}
export function resolveBundledSession(session: NappletDescriptor) {
  if (session.eventId !== undefined) throw new Error('Unavailable saved napplet');
  const variant = variants.find(value => session.id.startsWith(value + '-'));
  const number = Number(session.title.match(/ ([1-9][0-9]*)$/)?.[1]);
  if (!variant || !Number.isSafeInteger(number)) throw new Error('Unavailable saved napplet');
  const instance = session.id.slice(variant.length + 1);
  if (instance !== String(number) && !uuid.test(instance)) throw new Error('Unavailable saved napplet');
  if (variant === 'ux-lab' && instance !== String(number)) throw new Error('Unavailable saved napplet');
  const expected = bundledDescriptor(variant, number, instance);
  const compatibleSupport = variant === 'nap-support' && session.version === previousSupportVersion;
  const archivedFixture = variant === 'approval-lab'
    ? (['approval-lab-v1', 'approval-lab-v2', 'approval-lab-v3'] as const).find(key => session.version === BUNDLED_FIXTURES[key].aggregateHash)
    : variant === 'feed-lab' && session.version === BUNDLED_FIXTURES['feed-lab-v1'].aggregateHash
      ? 'feed-lab-v1' : undefined;
  if (session.title !== expected.title || session.publisher !== expected.publisher || session.appId !== expected.appId ||
      (session.version !== expected.version && !compatibleSupport && !archivedFixture) || session.source !== expected.source) throw new Error('Unavailable saved napplet');
  // Select the exact retained bytes rather than silently upgrading a saved pin.
  const fixture = archivedFixture ?? (variant === 'state-lab-other-publisher' ? 'state-lab' : variant);
  const entry = BUNDLED_FIXTURES[fixture];
  return Object.freeze({ fixture, appId: entry.appId, version: entry.aggregateHash, domains: entry.domains,
    // Reserved unsigned-fixture namespace identifiers, never presented as Nostr publisher identities.
    publisher: variant === 'state-lab-other-publisher' ? 'f'.repeat(62) + 'fe' : 'f'.repeat(64),
    instanceId: session.id });
}
export function assertBundledWorkspace(workspace: Workspace): void {
  for (const session of workspace.sessions) resolveBundledSession(session);
}

const HEX64 = /^[0-9a-f]{64}$/;
const validAppId = (value: string): boolean => value.length > 0 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).byteLength <= 255;
function assertPublishedSession(session: NappletDescriptor): void {
  if (session.source !== 'published' || !uuid.test(session.id) || !HEX64.test(session.publisher) || !HEX64.test(session.version) ||
      !HEX64.test(session.eventId ?? '') || !validAppId(session.appId) || session.title.length === 0 ||
      new TextEncoder().encode(session.title).byteLength > 128) throw new Error('Unavailable saved napplet');
}

/** Validate only the durable source claims; published rows are not verified artifacts until reopened. */
export function assertWorkspaceAvailability(workspace: Workspace): void {
  for (const session of workspace.sessions) {
    if (session.source === 'bundled') resolveBundledSession(session);
    else assertPublishedSession(session);
  }
}
