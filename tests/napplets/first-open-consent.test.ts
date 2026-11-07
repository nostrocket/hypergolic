import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { assertVerifiedNappletAdmission, FirstOpenConsentError, requestFirstOpenConsent, publishedCapabilityCompatibility } from '../../src/napplets/first-open-consent.ts';
import { stageAdmittedPublishedArtifact } from '../../src/napplets/admitted-transfer.ts';
import { descriptorForPublishedArtifact, publishedHostInput } from '../../src/napplets/published-host-input.ts';
import type { NativePublishedTransferPort } from '../../src/napplets/native-transfer.ts';
import { registration, setup } from '../storage/harness.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 11;
const publisher = getPublicKey(SECRET);
const user = '12'.repeat(32);
const html = new TextEncoder().encode('<!doctype html><html><head><title>Consent test</title></head><body>ok</body></html>');
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }
async function artifact(required = ['theme'], optional?: string[]) {
  const htmlHash = await sha(html), aggregate = await sha(new TextEncoder().encode(`${htmlHash} /index.html\n`));
  const tags = optional === undefined ? [
    ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'],
    ...required.map(domain => ['requires', domain]),
  ] : [['x', htmlHash], ...required.map(domain => ['R', domain]), ...optional.map(domain => ['O', domain])];
  const event = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: optional ? 'Modern hello' : '',
    tags: [['d', 'hello'], ...tags] }, SECRET);
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
  assert.deepEqual(seen, { user, publisher, appId: 'hello', eventId: candidate.manifest.eventId, domains: ['theme'], unsupportedDomains: [], optionalDomains: [], unsupportedOptionalDomains: [] });
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

test('saved current-profile grants retain exact prior authority until Common is explicitly reviewed', async t => {
  const {database} = await setup(t);
  const {owner,storage} = control(database);
  const required = ['common','identity','keys','media','outbox','theme'];
  const candidate = await artifact(required,[]);
  const prior = publishedCapabilityCompatibility(required,[],'before-common');
  await storage.replaceAccessGrant(prior.grantedDomains,null,{},prior.review);
  const before = await storage.readAccessGrant();
  const signal = new AbortController().signal;
  const pinned = await requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,
    async () => assert.fail('saved exact pin must preserve old access'),'saved-pin');
  assert.equal(pinned.supportProfile,'before-common');
  assert.deepEqual(pinned.domains,['identity','keys','media','outbox','theme']);
  assertVerifiedNappletAdmission(pinned,candidate);
  await assert.rejects(requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,async review => {
    assert.deepEqual(review.unsupportedDomains,[]);return false;
  }),FirstOpenConsentError);
  assert.deepEqual(await storage.readAccessGrant(),before);
  const admitted = await requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,async()=>true);
  assert.deepEqual(admitted.domains,required);
  assert.equal(admitted.supportProfile,'current');
  assertVerifiedNappletAdmission(admitted,candidate);
});

test('unsupported names remain warning-only and a changed requested set or host profile requires review', async t => {
  const { database } = await setup(t); const { owner, storage } = control(database);
  const first = await artifact(['theme', 'fs', 'gamepad']);
  let prompts = 0;
  const accept = async (request: import('../../src/napplets/first-open-consent.ts').NappletConsentReview) => {
    prompts++; assert.deepEqual(request.unsupportedDomains, ['fs', 'gamepad']); return true;
  };
  const admitted = await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.deepEqual(admitted.domains, ['theme']);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
  await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.equal(prompts, 1);
  const current = (await storage.readAccessGrant())!;
  const olderReview = JSON.stringify({profile: 'hypergolic-native-2026-10-13-v1',
    requested: ['fs', 'gamepad', 'theme'], domains: ['theme']});
  await storage.replaceAccessGrant(current.domains, current.revision, {}, olderReview);
  await assert.rejects(requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, async () => false),
    FirstOpenConsentError);
  assert.equal((await storage.readAccessGrant())?.supportReview, olderReview);
  await requestFirstOpenConsent(first, owner, storage, new AbortController().signal, owner.assertActive, accept);
  assert.equal(prompts, 2);
  const changed = await artifact(['theme', 'gamepad']);
  await requestFirstOpenConsent(changed, owner, storage, new AbortController().signal, owner.assertActive, async request => {
    prompts++; assert.deepEqual(request.unsupportedDomains, ['gamepad']); return true;
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

test('modern review separates optional access and binds only approved supported domains to the native host', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const signal = new AbortController().signal;
  const legacy = await artifact(['theme']);
  await requestFirstOpenConsent(legacy, owner, storage, signal, owner.assertActive, async () => true);
  const modern = await artifact(['theme', 'unknown-required'], ['storage', 'unknown-optional']);
  assert.equal(modern.manifest.versionId, legacy.manifest.versionId);
  await assert.rejects(requestFirstOpenConsent(modern, owner, storage, signal, owner.assertActive, async request => {
    assert.deepEqual(request.domains, ['theme', 'unknown-required']);
    assert.deepEqual(request.optionalDomains, ['storage', 'unknown-optional']);
    assert.deepEqual(request.unsupportedDomains, ['unknown-required']);
    assert.deepEqual(request.unsupportedOptionalDomains, ['unknown-optional']);
    return false;
  }), FirstOpenConsentError);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['theme']);
  const admission = await requestFirstOpenConsent(modern, owner, storage, signal, owner.assertActive, async () => true);
  const descriptor = descriptorForPublishedArtifact(modern, '58274370-ec8f-4058-a4cc-b63e7e75ca4b');
  const wire = JSON.parse(publishedHostInput(modern, admission, descriptor, {user, epoch: 0, assertActive: owner.assertActive}, 'stage'));
  assert.deepEqual(JSON.parse(wire.configuration).domains, ['storage', 'theme']);
  assert.deepEqual((await storage.readAccessGrant())?.domains, ['storage', 'theme']);
  await requestFirstOpenConsent(modern, owner, storage, signal, owner.assertActive, async () => assert.fail('same grant must reopen'));

  const reclassified = await artifact(['storage', 'theme', 'unknown-required'], ['unknown-optional']);
  await assert.rejects(requestFirstOpenConsent(reclassified, owner, storage, signal, owner.assertActive, async request => {
    assert.deepEqual(request.domains, ['storage', 'theme', 'unknown-required']);
    return false;
  }), FirstOpenConsentError);
});

test('Intent requires explicit renewal while an unchanged non-Intent baseline grant still reopens', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const signal = new AbortController().signal;
  const profile = 'hypergolic-native-2026-11-06-v1';
  const previousReview = (domains: string[]) => JSON.stringify({profile, requested: domains, domains});
  const game = await artifact(['theme'], []);
  await storage.replaceAccessGrant(['theme'], null, {}, previousReview(['theme']));
  await requestFirstOpenConsent(game, owner, storage, signal, owner.assertActive, async () => assert.fail('unchanged grant must reopen'));

  const baseline = (await storage.readAccessGrant())!;
  const handler = await artifact(['theme'], ['intent']);
  const intentReview = JSON.stringify([previousReview(['theme']), previousReview(['intent'])]);
  await storage.replaceAccessGrant(['intent', 'theme'], baseline.revision, {}, intentReview);
  const previous = await storage.readAccessGrant();
  await assert.rejects(requestFirstOpenConsent(handler, owner, storage, signal, owner.assertActive, async request => {
    assert.equal(request.eventId, handler.manifest.eventId);
    assert.deepEqual(request.optionalDomains, ['intent']);
    return false;
  }), FirstOpenConsentError);
  assert.deepEqual(await storage.readAccessGrant(), previous);
  await requestFirstOpenConsent(handler, owner, storage, signal, owner.assertActive, async () => true);
  assert.match((await storage.readAccessGrant())!.supportReview, /hypergolic-native-2026-11-06-intent-v1/);
  await requestFirstOpenConsent(handler, owner, storage, signal, owner.assertActive, async () => assert.fail('renewed Intent grant must reopen'));
});


for (const previouslyOffered of [false, true]) {
  test(`the file profile renews Media consent after ${previouslyOffered ? 'the 10 MiB profile' : 'unavailable Media'}`, async t => {
    const {database} = await setup(t);
    const {owner, storage} = control(database);
    const candidate = await artifact(['media', 'theme'], []);
    const baseline = 'hypergolic-native-2026-11-06-v1';
    const profile = previouslyOffered ? `${baseline}/hypergolic-native-2026-11-06-media-v1` : baseline;
    const domains = previouslyOffered ? ['media', 'theme'] : ['theme'];
    const older = JSON.stringify({profile, requested:['media','theme'], domains});
    await storage.replaceAccessGrant(domains, null, {}, older);
    const signal = new AbortController().signal;
    await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async request => {
      assert.deepEqual(request.domains, ['media','theme']);
      assert.deepEqual(request.unsupportedDomains, []);
      return false;
    }), FirstOpenConsentError);
    assert.equal((await storage.readAccessGrant())?.supportReview, older);
    const accepted = await requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async () => true);
    assert.deepEqual(accepted.domains, ['media','theme']);
    assert.match((await storage.readAccessGrant())!.supportReview, /media-file-v1/);
  });
}

test('previous profile reopens an exact saved pin with its old grant and fresh review enables Keys', async t => {
  for (const intent of [false, true]) await t.test(intent ? 'existing Intent profile' : 'existing base profile', async t => {
    const {database} = await setup(t); const {owner, storage} = control(database);
    const required = ['theme'];
    const optional = intent ? ['gamepad', 'intent', 'keys'] : ['gamepad', 'keys'];
    const previousOptional = intent ? ['intent'] : [];
    const previousDomains = [...previousOptional, 'theme'];
    const candidate = await artifact(required, optional);
    const oldReview = JSON.stringify([
      JSON.stringify({profile: 'hypergolic-native-2026-11-06-v1', requested: ['theme'], domains: ['theme']}),
      JSON.stringify({profile: intent ? 'hypergolic-native-2026-11-06-intent-v1' : 'hypergolic-native-2026-11-06-v1',
        requested: optional, domains: previousOptional}),
    ]);
    await storage.replaceAccessGrant(previousDomains, null, {}, oldReview);
    const signal = new AbortController().signal;
    const hostDomains = (admission: unknown) => {
      const descriptor = descriptorForPublishedArtifact(candidate, '58274370-ec8f-4058-a4cc-b63e7e75ca4b');
      const wire = JSON.parse(publishedHostInput(candidate, admission, descriptor,
        {user, epoch: 0, assertActive: owner.assertActive}, 'stage'));
      return JSON.parse(wire.configuration).domains;
    };
    const reopen = () => requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive,
      async () => assert.fail('exact saved pin must keep its previous grant'), 'saved-pin');
    const oldAdmission = await reopen();
    assert.deepEqual(hostDomains(oldAdmission), previousDomains);
    assert.throws(() => hostDomains({...oldAdmission, domains: ['keys', 'theme']}));
    assert.throws(() => hostDomains({...oldAdmission, supportProfile: 'current'}));

    await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async review => {
      assert.deepEqual(review.optionalDomains, optional);
      assert.deepEqual(review.unsupportedOptionalDomains, ['gamepad']);
      return false;
    }), FirstOpenConsentError);
    assert.equal((await storage.readAccessGrant())?.supportReview, oldReview);
    assert.deepEqual(hostDomains(await reopen()), previousDomains);

    const current = (await storage.readAccessGrant())!;
    await storage.replaceAccessGrant([...previousOptional, 'keys', 'theme'], current.revision, {}, oldReview);
    await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive,
      async () => false, 'saved-pin'), FirstOpenConsentError);

    const approved = await requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async () => true);
    assert.deepEqual(hostDomains(approved), [...previousOptional, 'keys', 'theme']);
  });
});

test('a remembered Outbox and Intent grant without Relay needs consent for independent Outbox authority', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const signal = new AbortController().signal;
  const candidate = await artifact(['intent', 'outbox'], []);
  const domains = ['intent', 'outbox'];
  const prior = JSON.stringify({profile: 'hypergolic-native-2026-11-06-intent-v1', requested: domains, domains});
  await storage.replaceAccessGrant(domains, null, {}, prior);
  await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async () => false),
    FirstOpenConsentError);
  assert.equal((await storage.readAccessGrant())?.supportReview, prior);
  const approved = await requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async () => true);
  assert.deepEqual(approved.domains, domains);
  assert.match((await storage.readAccessGrant())!.supportReview, /hypergolic-native-2026-11-06-outbox-intent-v1/);
});


test('a remembered active Outbox and Relay grant with the same effective access needs no new review', async t => {
  const {database} = await setup(t); const {owner, storage} = control(database);
  const required = ['outbox', 'theme'];
  const optional = ['intent', 'relay'];
  const candidate = await artifact(required, optional);
  const prior = JSON.stringify([
    JSON.stringify({profile: 'hypergolic-native-2026-11-06-v1', requested: required, domains: required}),
    JSON.stringify({profile: 'hypergolic-native-2026-11-06-intent-v1', requested: optional, domains: optional}),
  ]);
  const stored = await storage.replaceAccessGrant([...required, ...optional], null, {}, prior);
  const accepted = await requestFirstOpenConsent(candidate, owner, storage, new AbortController().signal,
    owner.assertActive, async () => assert.fail('unchanged effective access must reuse the exact old grant'));
  assert.deepEqual(accepted.domains, ['intent', 'outbox', 'relay', 'theme']);
  assert.deepEqual(await storage.readAccessGrant(), stored);
});

test('saved mixed pins keep effective legacy authority until a new review accepts the exact set', async t => {
  for (const relay of [false, true]) await t.test(relay ? 'previous Relay grant' : 'no previous Relay grant', async t => {
    const {database} = await setup(t); const {owner, storage} = control(database);
    const required = ['intent', 'keys', 'outbox', 'theme'];
    const optional = relay ? ['media', 'relay'] : ['media'];
    const candidate = await artifact(required, optional);
    const priorRequired = ['intent', 'outbox', 'theme'];
    const priorOptional = relay ? ['relay'] : [];
    const prior = JSON.stringify([
      JSON.stringify({profile: 'hypergolic-native-2026-11-06-intent-v1', requested: required, domains: priorRequired}),
      JSON.stringify({profile: 'hypergolic-native-2026-11-06-v1', requested: optional, domains: priorOptional}),
    ]);
    await storage.replaceAccessGrant([...priorRequired, ...priorOptional], null, {}, prior);
    const previous = await storage.readAccessGrant();
    const signal = new AbortController().signal;
    const descriptor = descriptorForPublishedArtifact(candidate, '58274370-ec8f-4058-a4cc-b63e7e75ca4b');
    const hostDomains = (admission: unknown) => JSON.parse(JSON.parse(publishedHostInput(candidate, admission,
      descriptor, {user, epoch: 0, assertActive: owner.assertActive}, 'stage')).configuration).domains;
    const reopen = () => requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive,
      async () => assert.fail('saved pin must keep effective legacy authority'), 'saved-pin');
    const effective = relay ? ['intent', 'outbox', 'relay', 'theme'] : ['intent', 'theme'];
    assert.deepEqual(hostDomains(await reopen()), effective);
    await assert.rejects(requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async review => {
      assert.deepEqual(review.domains, required);
      assert.deepEqual(review.optionalDomains, optional);
      assert.deepEqual(review.unsupportedDomains, []);
      assert.deepEqual(review.unsupportedOptionalDomains, []);
      return false;
    }), FirstOpenConsentError);
    assert.deepEqual(await storage.readAccessGrant(), previous);
    assert.deepEqual(hostDomains(await reopen()), effective);

    const accepted = await requestFirstOpenConsent(candidate, owner, storage, signal, owner.assertActive, async () => true);
    const granted = [...required, ...optional].sort();
    assert.deepEqual(hostDomains(accepted), granted);
    const current = (await storage.readAccessGrant())!;
    assert.deepEqual(current.domains, granted);
    assert.match(current.supportReview!, /outbox-keys-intent-v1/);
    assert.match(current.supportReview!, /media-file-v1/);
    assert.deepEqual(hostDomains(await reopen()), granted);
  });
});

test('Common social authority needs fresh review even with identical old domains split across required/optional',async t=>{
  for(const partition of [0,1,2])await t.test(String(partition),async t=>{
    const {database}=await setup(t),{owner,storage}=control(database);
    const required=partition===0?['common','identity','relay']:partition===1?['common']:['common','identity'];
    const optional=partition===0?[]:partition===1?['identity','outbox']:['relay'];
    const candidate=await artifact(required,optional),prior=publishedCapabilityCompatibility(required,optional,'before-social');
    await storage.replaceAccessGrant(prior.domains,null,{},prior.review);const old=await storage.readAccessGrant();
    const signal=new AbortController().signal,descriptor=descriptorForPublishedArtifact(candidate,'58274370-ec8f-4058-a4cc-b63e7e75ca4b');
    const config=(admission:unknown)=>JSON.parse(JSON.parse(publishedHostInput(candidate,admission,descriptor,{user,epoch:0,assertActive:owner.assertActive},'stage')).configuration);
    const saved=await requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,async()=>assert.fail('Saved read pin cannot broaden'),'saved-pin');assert.equal(config(saved).commonProfile,undefined);
    await assert.rejects(requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,async()=>false),FirstOpenConsentError);assert.deepEqual(await storage.readAccessGrant(),old);
    const approved=await requestFirstOpenConsent(candidate,owner,storage,signal,owner.assertActive,async()=>true);assert.equal(config(approved).commonProfile,'social-v1');assert.deepEqual(config(approved).domains,prior.domains);
    assert.notEqual((await storage.readAccessGrant())!.supportReview,prior.review);assert.equal(config(saved).commonProfile,undefined);
  });
});
