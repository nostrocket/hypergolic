import type { UploadService } from '../../src/uploads/upload-service.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { naddrEncode } from 'nostr-tools/nip19';
import { finalizeEvent } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';
import { EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT, EMBEDDED_TEST_PUBLISHER,
  getEmbeddedTestHtmlBytes } from '../../src/napplets/embedded-test-fixture.ts';
import { createPublishedSessionCoordinator, type PublishedSessionDependencies } from '../../src/napplets/published-session.ts';
import type { NativePublishedTransferPort } from '../../src/napplets/native-transfer.ts';
import { setup } from '../storage/harness.ts';
import { createRuntimeOwner } from '../../src/runtime/runtime-owner.ts';
import { emptyWorkspace, openNapplet, closeNapplet, replacePublishedNapplet } from '../../src/shell/workspace.ts';
import { NativeLeases } from '../runtime/native-leases.ts';
import type { IdentityTransition } from '../../src/security/identity-transition.ts';
import { createApprovalOwner, createUploadOwner } from '../../src/security/approval-owner.ts';
import type { ApprovalOrigin, ApprovalService } from '../../src/security/approval-service.ts';

const USER = '31'.repeat(32);
const SESSION = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';
const LINK = naddrEncode(EMBEDDED_TEST_COORDINATE);
function signedFixture(createdAt: number, appId: string, html: Uint8Array, domains: readonly string[], secret: Uint8Array) {
  const htmlHash = createHash('sha256').update(html).digest('hex');
  const aggregate = createHash('sha256').update(`${htmlHash} /index.html\n`).digest('hex');
  return finalizeEvent({ kind: 35129, created_at: createdAt, content: '', tags: [
    ['d', appId], ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'],
    ...domains.map(domain => ['requires', domain]),
  ] }, secret);
}

function native(calls: string[]): NativePublishedTransferPort {
  return {
    registerPublishedSession: id => { calls.push(`register:${id}`); return true; },
    beginPublishedArtifact: () => { calls.push('begin'); return 'upload'; },
    appendPublishedArtifact: () => { calls.push('append'); return true; },
    finishPublishedArtifact: () => { calls.push('finish'); return 'a'.repeat(64); },
    cancelPublishedArtifact: () => { calls.push('cancel'); },
    revokePublishedSession: id => { calls.push(`revoke:${id}`); },
    revokeAllPublishedArtifacts: () => { calls.push('revoke-all'); },
  };
}

test('first open verifies, reviews, caches and stages; pinned restart uses cache without a new review', async t => {
  const { database, sqlite } = await setup(t);
  let epoch = 3, queries = 0, reads = 0, reviews = 0;
  const calls: string[] = [];
  const ports: PublishedSessionDependencies = {
    database, sqlite, native: native(calls), newInstanceId: () => SESSION,
    identity: { sessionAuthority: () => ({ user: USER, epoch, assertActive: () => {
      if (epoch !== 3) throw new Error('stale identity');
    } }), getSnapshot: () => ({ session: { epoch } }) } as PublishedSessionDependencies['identity'],
    lookupRelays: () => ['wss://relay.example.org'],
    source: {
      query: async (coordinate, relays, pinned) => {
        queries++;
        assert.deepEqual(coordinate, { kind: 35129, pubkey: EMBEDDED_TEST_PUBLISHER,
          identifier: EMBEDDED_TEST_COORDINATE.identifier });
        assert.deepEqual(relays, ['wss://relay.example.org']);
        if (queries > 1) assert.equal(pinned, EMBEDDED_TEST_EVENT.id);
        return [EMBEDDED_TEST_EVENT];
      },
      readHtml: async () => { reads++; return getEmbeddedTestHtmlBytes(); },
    },
  };
  const service = createPublishedSessionCoordinator(ports);
  const opened = await service.openLink(LINK, new AbortController().signal, async request => {
    reviews++; assert.deepEqual(request.domains, ['theme']); return true;
  });
  assert.equal(opened.descriptor.eventId, EMBEDDED_TEST_EVENT.id);
  assert.equal(JSON.parse(JSON.parse(opened.hostInput).configuration).fixture, 'published');
  assert.deepEqual(calls.slice(0, 4), [`register:${SESSION}`, 'begin', 'append', 'finish']);
  opened.revoke();
  const reopened = await service.reopenPinned(opened.descriptor, new AbortController().signal,
    async () => { assert.fail('saved exact grant must reopen silently'); });
  assert.equal(JSON.parse(reopened.hostInput).eventId, opened.descriptor.eventId);
  assert.equal(queries, 1);
  assert.equal(reads, 1);
  assert.equal(reviews, 1);
  reopened.revoke();
  epoch++;
  assert.throws(() => reopened.assertActive());
});

test('unsupported requested capabilities warn and launch without native grants; denial prevents launch', async t => {
  const { database, sqlite } = await setup(t);
  const html = getEmbeddedTestHtmlBytes();
  const appId = 'unsupported-capabilities';
  const event = signedFixture(1_800_000_003, appId, html, ['webrtc', 'cvm'], new Uint8Array(32).fill(8));
  const calls: string[] = [];
  const service = createPublishedSessionCoordinator({
    database, sqlite, native: native(calls), newInstanceId: () => SESSION,
    identity: { sessionAuthority: () => ({ user: USER, epoch: 1, assertActive: () => undefined }),
      getSnapshot: () => ({ session: { epoch: 1 } }) } as PublishedSessionDependencies['identity'],
    lookupRelays: () => ['wss://relay.example.org'],
    source: { query: async () => [event], readHtml: async () => new Uint8Array(html) },
  });
  const link = naddrEncode({ kind: 35129, pubkey: event.pubkey, identifier: appId });
  await assert.rejects(service.openLink(link, new AbortController().signal, async review => {
    assert.deepEqual(review.unsupportedDomains, ['cvm', 'webrtc']); return false;
  }));
  assert.deepEqual(calls, []);
  const opened = await service.openLink(link, new AbortController().signal, async review => {
    assert.deepEqual(review.domains, ['cvm', 'webrtc']);
    assert.deepEqual(review.unsupportedDomains, ['cvm', 'webrtc']); return true;
  });
  assert.deepEqual(JSON.parse(JSON.parse(opened.hostInput).configuration).domains, []);
  assert(calls.includes('finish'));
  opened.revoke();
  const reopened = await service.reopenPinned(opened.descriptor, new AbortController().signal, async () => {
    assert.fail('unchanged support warning is remembered across reopen');
  });
  reopened.revoke();
});

test('denial and identity change during review never register a native published session', async t => {
  const { database, sqlite } = await setup(t);
  let epoch = 1;
  const calls: string[] = [];
  const service = createPublishedSessionCoordinator({ database, sqlite, native: native(calls),
    newInstanceId: () => SESSION, lookupRelays: () => ['wss://relay.example.org'],
    identity: { sessionAuthority: () => ({ user: USER, epoch, assertActive: () => {
      if (epoch !== 1) throw new Error('stale identity');
    } }), getSnapshot: () => ({ session: { epoch } }) } as PublishedSessionDependencies['identity'],
    source: { query: async () => [EMBEDDED_TEST_EVENT], readHtml: async () => getEmbeddedTestHtmlBytes() },
  });
  await assert.rejects(service.openLink(LINK, new AbortController().signal, async () => false));
  assert.deepEqual(calls, []);
  await assert.rejects(service.openLink(LINK, new AbortController().signal, async () => {
    epoch++; return true;
  }));
  assert.deepEqual(calls, []);
});

test('workspace runtime consumes the reviewed artifact once and revokes it on close', async t => {
  const { database, sqlite } = await setup(t);
  let epoch = 5, workspace = emptyWorkspace();
  const calls: string[] = [];
  const leases = Object.assign(new NativeLeases(), native(calls));
  const identity = {
    sessionAuthority: () => ({ user: USER, epoch, assertActive: () => { if (epoch !== 5) throw new Error('stale'); } }),
    getSnapshot: () => ({ session: { epoch, workspace: { getSnapshot: () => ({ workspace, error: null }) } } }),
  } as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const owner = createRuntimeOwner(database, identity, leases, undefined, {
    sqlite, native: leases, lookupRelays: () => ['wss://relay.example.org'],
    source: { query: async () => [EMBEDDED_TEST_EVENT], readHtml: async () => getEmbeddedTestHtmlBytes() },
  });
  const descriptor = await owner.openPublishedLink(LINK, new AbortController().signal, async () => true);
  workspace = openNapplet(workspace, descriptor);
  const binding = await owner.openPublished(descriptor, new AbortController().signal, async () => {
    assert.fail('saved grant does not need a second review');
  });
  assert.equal(JSON.parse(binding.publishedArtifact).sessionId, descriptor.id);
  await assert.rejects(owner.openPublished(descriptor, new AbortController().signal, async () => true), { code: 'CONFLICT' });
  workspace = closeNapplet(workspace, descriptor.id);
  binding.revoke();
  assert(calls.includes(`revoke:${descriptor.id}`));
  binding.receive({ type: 'capability', sessionId: descriptor.id, generation: 'native-generation', token: 'token' });
  assert.equal(leases.finishCalls, 0);
  epoch++;
});

test('published relay approval needs the live verified session and its native generation', async t => {
  const { database, sqlite } = await setup(t);
  const html = getEmbeddedTestHtmlBytes();
  const appId = 'published-approval-test';
  const event = signedFixture(1_800_000_001, appId, html, ['relay', 'theme'], new Uint8Array(32).fill(7));
  const link = naddrEncode({ kind: 35129, pubkey: event.pubkey, identifier: appId });
  let workspace = emptyWorkspace();
  const identity = {
    sessionAuthority: () => ({ user: USER, epoch: 2, assertActive: () => undefined }),
    getSnapshot: () => ({ session: { epoch: 2, workspace: { getSnapshot: () => ({ workspace, error: null }) } } }),
  } as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const leases = Object.assign(new NativeLeases(), native([]));
  let offered: ApprovalOrigin | null = null;
  const approvals = { enqueue: (_token: string, _destinations: readonly string[], origin: ApprovalOrigin) => {
    offered = origin; return true;
  }, close: () => undefined } as unknown as ApprovalService;
  const owner = createRuntimeOwner(database, identity, leases,
    { service: approvals, destinations: () => ['wss://relay.example.org'] },
    { sqlite, native: leases, lookupRelays: () => ['wss://relay.example.org'],
      source: { query: async () => [event], readHtml: async () => new Uint8Array(html) } });
  const descriptor = await owner.openPublishedLink(link, new AbortController().signal, async request => {
    assert.deepEqual(request.domains, ['relay', 'theme']); return true;
  });
  workspace = openNapplet(workspace, descriptor);
  const binding = await owner.openPublished(descriptor, new AbortController().signal, async () => {
    assert.fail('saved exact grant must not ask again');
  });
  const generation = 'native-generation';
  binding.receive({ type: 'capability', sessionId: descriptor.id, generation, token: 'native-token', lane: 'approval' });
  assert(offered);
  const origin = offered as ApprovalOrigin;
  const approvalOwner = createApprovalOwner(identity, candidate => owner.assertPublishedApproval(candidate));
  assert.doesNotThrow(() => approvalOwner.assertActive(origin));
  assert.throws(() => approvalOwner.assertActive({ ...origin, generation: 'other-generation' }));
  assert.throws(() => approvalOwner.assertActive({ ...origin, appId: 'other-app' }));
  binding.revoke();
  assert.throws(() => approvalOwner.assertActive(origin));
});

test('verified update is inert until explicit review and cannot roll back to an older event', async t => {
  const { database, sqlite } = await setup(t);
  const appId = 'published-update-test';
  const originalHtml = getEmbeddedTestHtmlBytes();
  const updatedHtml = new TextEncoder().encode(new TextDecoder().decode(originalHtml).replace('fixture-loaded', 'fixture-updated'));
  const key = new Uint8Array(32).fill(11);
  const oldEvent = signedFixture(1_800_000_001, appId, originalHtml, ['theme'], key);
  const newEvent = signedFixture(1_800_000_002, appId, updatedHtml, ['theme'], key);
  const link = naddrEncode({ kind: 35129, pubkey: oldEvent.pubkey, identifier: appId });
  const calls: string[] = [];
  let epoch = 1, latest = oldEvent;
  const service = createPublishedSessionCoordinator({ database, sqlite, native: native(calls),
    newInstanceId: (() => { let next = 0; return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`; })(),
    lookupRelays: () => ['wss://relay.example.org'],
    identity: { sessionAuthority: () => ({ user: USER, epoch, assertActive: () => { if (epoch !== 1) throw new Error('stale'); } }),
      getSnapshot: () => ({ session: { epoch } }) } as PublishedSessionDependencies['identity'],
    source: { query: async (_coordinate, _relays, pinned) => pinned === oldEvent.id ? [oldEvent] : [latest],
      readHtml: async hash => new Uint8Array(hash === oldEvent.tags[1]![2] ? originalHtml : updatedHtml) },
  });
  const opened = await service.openLink(link, new AbortController().signal, async () => true);
  const count = calls.length;
  latest = newEvent;
  await assert.rejects(service.prepareUpdate(opened.descriptor, new AbortController().signal,
    async request => { assert.equal(request.nextEventId, newEvent.id); return false; }, async () => true));
  assert.equal(calls.length, count);
  const cancelled = new AbortController();
  await assert.rejects(service.prepareUpdate(opened.descriptor, cancelled.signal,
    async () => { cancelled.abort(); return true; }, async () => true));
  assert.equal(calls.length, count);
  await assert.rejects(service.prepareUpdate(opened.descriptor, new AbortController().signal,
    async () => { epoch = 2; return true; }, async () => true));
  assert.equal(calls.length, count);
  epoch = 1;
  const updated = await service.prepareUpdate(opened.descriptor, new AbortController().signal,
    async request => { assert.equal(request.previousEventId, oldEvent.id); return true; }, async () => {
      assert.fail('unchanged capability grant must not be reviewed again');
    });
  assert(updated);
  assert.equal(updated.descriptor.eventId, newEvent.id);
  assert.notEqual(updated.descriptor.id, opened.descriptor.id);
  assert.notEqual(updated.descriptor.version, opened.descriptor.version);
  opened.revoke();
  assert.equal(await service.prepareUpdate(updated.descriptor, new AbortController().signal,
    async () => { assert.fail('same event is not an update'); }, async () => true), null);
  latest = oldEvent;
  await assert.rejects(service.prepareUpdate(updated.descriptor, new AbortController().signal,
    async () => { assert.fail('rollback cannot be reviewed'); }, async () => true));
  updated.revoke();
  epoch++;
});

test('accepted runtime update consumes a new native session at the old workspace position', async t => {
  const { database, sqlite } = await setup(t);
  const appId = 'workspace-update-test', key = new Uint8Array(32).fill(19);
  const firstHtml = getEmbeddedTestHtmlBytes();
  const secondHtml = new TextEncoder().encode(new TextDecoder().decode(firstHtml).replace('fixture-loaded', 'new-version-loaded'));
  const firstEvent = signedFixture(1_800_000_010, appId, firstHtml, ['theme'], key);
  const secondEvent = signedFixture(1_800_000_011, appId, secondHtml, ['theme'], key);
  let latest = firstEvent, workspace = emptyWorkspace();
  const identity = {
    sessionAuthority: () => ({ user: USER, epoch: 1, assertActive: () => undefined }),
    getSnapshot: () => ({ session: { epoch: 1, workspace: { getSnapshot: () => ({ workspace, error: null }) } } }),
  } as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const calls: string[] = [];
  const leases = Object.assign(new NativeLeases(), native(calls));
  const owner = createRuntimeOwner(database, identity, leases, undefined, { sqlite, native: leases,
    lookupRelays: () => ['wss://relay.example.org'],
    source: { query: async () => [latest], readHtml: async hash =>
      new Uint8Array(hash === firstEvent.tags[1]![2] ? firstHtml : secondHtml) },
  });
  const link = naddrEncode({ kind: 35129, pubkey: firstEvent.pubkey, identifier: appId });
  const first = await owner.openPublishedLink(link, new AbortController().signal, async () => true);
  workspace = openNapplet(workspace, first);
  const firstBinding = await owner.openPublished(first, new AbortController().signal, async () => true);
  latest = secondEvent;
  const next = await owner.preparePublishedUpdate(first, new AbortController().signal,
    async request => { assert.equal(request.nextEventId, secondEvent.id); return true; },
    async () => { assert.fail('unchanged grant must not prompt'); });
  assert(next);
  workspace = replacePublishedNapplet(workspace, first.id, next);
  owner.discardPublished(first.id);
  const secondBinding = await owner.openPublished(next, new AbortController().signal, async () => {
    assert.fail('prepared update must not reopen');
  });
  assert.equal(workspace.sessions[0]!.id, next.id);
  assert.equal(workspace.focusedId, next.id);
  assert.equal(JSON.parse(secondBinding.publishedArtifact).eventId, secondEvent.id);
  assert(calls.includes(`revoke:${first.id}`));
  firstBinding.revoke(); secondBinding.revoke();
});

test('changed update access needs a second review before any new native session', async t => {
  const { database, sqlite } = await setup(t);
  const appId = 'published-access-update-test', key = new Uint8Array(32).fill(23);
  const html = getEmbeddedTestHtmlBytes();
  const original = signedFixture(1_800_000_020, appId, html, ['theme'], key);
  const changed = signedFixture(1_800_000_021, appId, html, ['relay', 'theme'], key);
  const calls: string[] = [];
  let latest = original, nextId = 0;
  const service = createPublishedSessionCoordinator({ database, sqlite, native: native(calls),
    newInstanceId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    lookupRelays: () => ['wss://relay.example.org'],
    identity: { sessionAuthority: () => ({ user: USER, epoch: 1, assertActive: () => undefined }),
      getSnapshot: () => ({ session: { epoch: 1 } }) } as PublishedSessionDependencies['identity'],
    source: { query: async (_coordinate, _relays, pinned) => pinned === original.id ? [original] : [latest],
      readHtml: async () => new Uint8Array(html) },
  });
  const link = naddrEncode({ kind: 35129, pubkey: original.pubkey, identifier: appId });
  const opened = await service.openLink(link, new AbortController().signal, async () => true);
  const before = calls.length;
  latest = changed;
  await assert.rejects(service.prepareUpdate(opened.descriptor, new AbortController().signal,
    async request => { assert.deepEqual(request.domains, ['relay', 'theme']); return true; },
    async request => { assert.deepEqual(request.domains, ['relay', 'theme']); return false; }));
  assert.equal(calls.length, before);
  const accepted = await service.prepareUpdate(opened.descriptor, new AbortController().signal,
    async () => true, async request => { assert.deepEqual(request.domains, ['relay', 'theme']); return true; });
  assert(accepted);
  assert.equal(accepted.descriptor.eventId, changed.id);
  assert.equal(calls.filter(call => call.startsWith('register:')).length, 2);
  latest = signedFixture(1_800_000_022, appId, html, ['relay', 'theme', 'cvm'], key);
  const registrations = calls.filter(call => call.startsWith('register:')).length;
  await assert.rejects(service.prepareUpdate(accepted.descriptor, new AbortController().signal,
    async request => { assert.deepEqual(request.domains, ['cvm', 'relay', 'theme']); return true; },
    async request => { assert.deepEqual(request.unsupportedDomains, ['cvm']); return false; }));
  assert.equal(calls.filter(call => call.startsWith('register:')).length, registrations);
  opened.revoke(); accepted.revoke();
});


test('published upload consent feeds the current workspace/native generation and revokes with its binding', async t => {
  const {database, sqlite} = await setup(t);
  const html = getEmbeddedTestHtmlBytes(), appId = 'published-upload-test';
  const event = signedFixture(1_800_000_004, appId, html, ['resource','upload'], new Uint8Array(32).fill(12));
  let workspace = emptyWorkspace(), offered: ApprovalOrigin | null = null;
  const identity = {sessionAuthority: () => ({user: USER, epoch: 2, assertActive: () => undefined}),
    getSnapshot: () => ({session: {epoch: 2, workspace: {getSnapshot: () => ({workspace, error: null})}}})} as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const leases = Object.assign(new NativeLeases(), native([]));
  const uploads = {enqueue: (_token: string, origin: ApprovalOrigin) => {offered = origin; return true;}, close: () => undefined} as unknown as UploadService;
  const owner = createRuntimeOwner(database, identity, leases, undefined,
    {sqlite, native: leases, lookupRelays: () => ['wss://relay.example.org'], source: {query: async () => [event], readHtml: async () => new Uint8Array(html)}},
    undefined, undefined, undefined, uploads);
  const link = naddrEncode({kind: 35129, pubkey: event.pubkey, identifier: appId});
  await assert.rejects(owner.openPublishedLink(link, new AbortController().signal, async () => false));
  const descriptor = await owner.openPublishedLink(link, new AbortController().signal, async request => {
    assert.deepEqual(request.domains, ['resource','upload']); return true;
  });
  workspace = openNapplet(workspace, descriptor);
  const binding = await owner.openPublished(descriptor, new AbortController().signal, async () => {assert.fail('saved exact grant must not review again');});
  assert.deepEqual(JSON.parse(JSON.parse(binding.publishedArtifact).configuration).domains, ['resource','upload']);
  binding.receive({type: 'capability', sessionId: descriptor.id, generation: 'native-generation', token: 'upload-token', lane: 'upload'});
  assert(offered); const origin = offered as ApprovalOrigin;
  const guard = createUploadOwner(identity, candidate => owner.assertPublishedUpload(candidate));
  assert.doesNotThrow(() => guard.assertActive(origin));
  for (const changed of [{...origin, generation: 'foreign'}, {...origin, publisher: 'f'.repeat(64)}, {...origin, appId: 'foreign'}, {...origin, version: 'f'.repeat(64)}, {...origin, instanceId: 'foreign'}, {...origin, user: 'f'.repeat(64)}, {...origin, epoch: 3}]) assert.throws(() => guard.assertActive(changed));
  binding.revoke(); assert.throws(() => guard.assertActive(origin));
});
