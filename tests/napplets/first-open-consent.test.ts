import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { assertVerifiedNappletAdmission, FirstOpenConsentError, requestFirstOpenConsent } from '../../src/napplets/first-open-consent.ts';
import { stageAdmittedPublishedArtifact } from '../../src/napplets/admitted-transfer.ts';
import type { NativePublishedTransferPort } from '../../src/napplets/native-transfer.ts';
import { registration, setup } from '../storage/harness.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 11;
const publisher = getPublicKey(SECRET);
const user = '12'.repeat(32);
const html = new TextEncoder().encode('<!doctype html><html><head><title>Consent test</title></head><body>ok</body></html>');
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }
async function artifact(required = ['theme']) {
  const htmlHash = await sha(html), aggregate = await sha(new TextEncoder().encode(`${htmlHash} /index.html\n`));
  const event = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '', tags: [
    ['d', 'hello'], ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'],
    ...required.map(domain => ['requires', domain]),
  ] }, SECRET);
  const coordinate = resolveNappletLink(naddrEncode({ kind: 35129, pubkey: publisher, identifier: 'hello' }));
  return verifyArtifact(await verifyManifest(coordinate, JSON.parse(JSON.stringify(event))), html);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const control = (database: Awaited<ReturnType<typeof setup>>['database'], active: { value: boolean } = { value: true }) => {
  const owner = registration({ user, publisher, appId: 'hello', assertActive: () => { if (!active.value) throw new Error('revoked'); } });
  return { owner, storage: database.bindApp(owner).port };
}

test('only explicit trusted review persists the exact publisher, signed coordinate and capabilities', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database);
  const candidate = await artifact(); let seen: unknown;
  const admission = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async request => { seen = request; return true; });
  assert.deepEqual(seen, { user, publisher, appId: 'hello', eventId: candidate.manifest.eventId, domains: ['theme'], unsupportedDomains: [] });
  assert.equal(Object.isFrozen(seen), true);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
  assertVerifiedNappletAdmission(admission, candidate);
  const reopened = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async () => { assert.fail('an exact existing grant must reopen silently'); });
  assertVerifiedNappletAdmission(reopened, candidate);
});

test('denial, changed capabilities, and structural lookalikes cannot admit', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database);
  const candidate = await artifact(); let prompts = 0;
  await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async () => { prompts++; return false; }), FirstOpenConsentError);
  assert.equal(await storage.readAccessGrant(), null);
  await assert.rejects(requestFirstOpenConsent({ ...candidate }, owner, storage, new AbortController().signal, owner.assertActive,
    async () => { prompts++; return true; }));
  assert.equal(prompts, 1);
  const first = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async () => { prompts++; return true; });
  const changed = await artifact(['theme', 'storage']);
  const changedAdmission = await requestFirstOpenConsent(changed, owner, storage, new AbortController().signal, owner.assertActive,
    async request => { prompts++; assert.deepEqual(request.domains, ['storage', 'theme']); return true; });
  assert.equal(prompts, 3);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['storage', 'theme']);
  assert.throws(() => assertVerifiedNappletAdmission(first, changed));
  assertVerifiedNappletAdmission(changedAdmission, changed);
});

test('frozen review snapshot prevents domain mutation before persistence', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database); const candidate = await artifact();
  await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, async request => {
    assert.throws(() => (request.domains as string[]).push('sign'));
    assert.throws(() => { (request as { appId: string }).appId = 'other'; });
    return true;
  });
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
});

test('owner mutation and abort while the trusted review is open deny without writing', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database); const candidate = await artifact();
  const ownerGate = deferred(), ownerPrompted = deferred();
  const mutableOwner = owner as { user: string; publisher: string; appId: string; assertActive: () => void };
  const ownerPending = requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, async () => {
    ownerPrompted.resolve(); await ownerGate.promise; return true;
  });
  await ownerPrompted.promise; mutableOwner.appId = 'substituted'; ownerGate.resolve();
  await assert.rejects(ownerPending, FirstOpenConsentError);
  mutableOwner.appId = 'hello';

  const controller = new AbortController(), abortGate = deferred(), abortPrompted = deferred();
  const abortPending = requestFirstOpenConsent(candidate, owner, storage, controller.signal, owner.assertActive, async () => {
    abortPrompted.resolve(); await abortGate.promise; return true;
  });
  await abortPrompted.promise; controller.abort(); abortGate.resolve();
  await assert.rejects(abortPending, FirstOpenConsentError);
  assert.equal(await storage.readAccessGrant(), null);
});

test('concurrent stale review loses the revision compare-and-swap', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database); const candidate = await artifact();
  const gate = deferred(), both = deferred(); let reviews = 0;
  const review = async () => { reviews++; if (reviews === 2) both.resolve(); await gate.promise; return true; };
  const first = requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, review);
  const second = requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, review);
  await both.promise; gate.resolve();
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(result => result.status === 'rejected' && result.reason instanceof FirstOpenConsentError).length, 1);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
});

test('identity revocation during review prevents persistence and invalidates existing admission', async t => {
  const { database } = await setup(t); const active = { value: true }; const { owner, storage } = control(database, active);
  const candidate = await artifact(); const gate = deferred(), prompted = deferred();
  const pending = requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, async () => {
    prompted.resolve(); await gate.promise; return true;
  });
  await prompted.promise; active.value = false; gate.resolve();
  await assert.rejects(pending, FirstOpenConsentError);
  assert.equal(await storage.readAccessGrant().catch(() => null), null);

  active.value = true;
  const admission = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive, async () => true);
  active.value = false;
  assert.throws(() => assertVerifiedNappletAdmission(admission, candidate), FirstOpenConsentError);
});

test('native staging refuses a forged admission and revokes an upload after identity changes', async t => {
  const { database } = await setup(t); const live = { value: true }; const { owner, storage } = control(database, live);
  const candidate = await artifact();
  const calls: string[] = [];
  const native: NativePublishedTransferPort = {
    registerPublishedSession: () => true,
    beginPublishedArtifact: () => { calls.push('begin'); return 'upload'; },
    appendPublishedArtifact: () => { calls.push('append'); live.value = false; return true; },
    finishPublishedArtifact: () => { calls.push('finish'); return 'handle'; },
    cancelPublishedArtifact: () => { calls.push('cancel'); },
    revokePublishedSession: () => { calls.push('revoke'); },
    revokeAllPublishedArtifacts: () => {},
  };
  await assert.rejects(stageAdmittedPublishedArtifact({}, candidate, 'session_1', native,
    new AbortController().signal, owner.assertActive));
  assert.deepEqual(calls, []);
  const admission = await requestFirstOpenConsent(candidate, owner, storage,
    new AbortController().signal, owner.assertActive, async () => true);
  await assert.rejects(stageAdmittedPublishedArtifact(admission, candidate, 'session_1', native,
    new AbortController().signal, owner.assertActive));
  assert.deepEqual(calls, ['begin', 'append', 'cancel']);
});

test('unsupported names remain warning-only and a changed requested set or host profile requires review', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database);
  const first = await artifact(['theme', 'fs', 'media']);
  let prompts = 0;
  const accept = async (request: import('../../src/napplets/first-open-consent.ts').NappletConsentReview) => {
    prompts++; assert.deepEqual(request.unsupportedDomains, ['fs', 'media']); return true;
  };
  const admitted = await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.deepEqual(admitted.domains, ['theme']);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
  await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.equal(prompts, 1);
  const current = (await storage.readAccessGrant())!;
  await storage.replaceAccessGrant(current.domains, current.revision, {}, 'older-host-profile');
  await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.equal(prompts, 2);
  const changed = await artifact(['theme', 'media']);
  await requestFirstOpenConsent(changed, owner, storage, new AbortController().signal, owner.assertActive, async request => {
    prompts++; assert.deepEqual(request.unsupportedDomains, ['media']); return true;
  });
  assert.equal(prompts, 3);
});


test('published Outbox requires fresh review of an older narrower support grant and denial cannot expand it', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const candidate = await artifact(['outbox', 'relay', 'theme']);
  const previousReview = JSON.stringify({profile: 'hypergolic-native-2026-10-06-v1',
    requested: ['outbox', 'relay', 'theme'], domains: ['relay', 'theme']});
  await storage.replaceAccessGrant(['relay', 'theme'], null, {}, previousReview);
  let prompts = 0;
  await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async request => {prompts++; assert.deepEqual(request.domains, ['outbox', 'relay', 'theme']); assert.deepEqual(request.unsupportedDomains, []); return false;}));
  assert.equal(prompts, 1); assert.deepEqual((await storage.readAccessGrant())?.domains, ['relay', 'theme']);
  const admission = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async () => {prompts++; return true;});
  assert.deepEqual(admission.domains, ['outbox', 'relay', 'theme']); assert.equal(prompts, 2);
  const reopened = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async () => {assert.fail('exact current approved grant should reopen');});
  assertVerifiedNappletAdmission(reopened, candidate);
});
test('an Outbox-only manifest does not acquire an undeclared relay grant', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const candidate = await artifact(['outbox']);
  const admission = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal, owner.assertActive,
    async request => {assert.deepEqual(request.domains, ['outbox']); return true;});
  assert.deepEqual(admission.domains, ['outbox']); assert.deepEqual((await storage.readAccessGrant())?.domains, ['outbox']);
});
