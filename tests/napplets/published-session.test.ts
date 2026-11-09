import type { UploadService } from '../../src/uploads/upload-service.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { naddrEncode,neventEncode } from 'nostr-tools/nip19';
import { finalizeEvent } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';
import { EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT, EMBEDDED_TEST_PUBLISHER,
  getEmbeddedTestHtmlBytes } from '../../src/napplets/embedded-test-fixture.ts';
import { createPublishedSessionCoordinator, type PublishedSessionDependencies } from '../../src/napplets/published-session.ts';
import type { NativePublishedTransferPort } from '../../src/napplets/native-transfer.ts';
import { publishedOpenFailureText } from '../../src/shell/published-settings-actions.ts';
import { registration, setup } from '../storage/harness.ts';
import { descriptorForPublishedArtifact } from '../../src/napplets/published-host-input.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { createRuntimeOwner } from '../../src/runtime/runtime-owner.ts';
import { emptyWorkspace, openNapplet, closeNapplet, replacePublishedNapplet, restoreWorkspace, snapshotWorkspace } from '../../src/shell/workspace.ts';
import { NativeLeases } from '../runtime/native-leases.ts';
import { ReviewBusyError } from '../../src/shell/review-slot.ts';
import type { IdentityTransition } from '../../src/security/identity-transition.ts';
import { createApprovalOwner, createUploadOwner } from '../../src/security/approval-owner.ts';
import type { ApprovalOrigin, ApprovalService } from '../../src/security/approval-service.ts';
import {snapshotAppKey} from '../../src/napplets/published-identity.ts';
import {PUBLISHED_ARTIFACT_CACHE_DATABASE} from '../../src/napplets/published-artifact-cache.ts';
import {decodeNativeRegistration} from '../../src/runtime/capability-protocol.ts';

const USER = '31'.repeat(32);
const SESSION = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';
const LINK = naddrEncode(EMBEDDED_TEST_COORDINATE);
function signedFixture(createdAt: number, appId: string, html: Uint8Array, domains: readonly string[], secret: Uint8Array, title?: string) {
  const htmlHash = createHash('sha256').update(html).digest('hex');
  const aggregate = createHash('sha256').update(`${htmlHash} /index.html\n`).digest('hex');
  return finalizeEvent({ kind: 35129, created_at: createdAt, content: '', tags: [
    ['d', appId], ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'],
    ...domains.map(domain => ['requires', domain]), ...(title ? [['title', title]] : []),
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


test('explicit Settings open retains bounded loader reasons before consent or staging', async t => {
  const { database, sqlite } = await setup(t);
  const html = getEmbeddedTestHtmlBytes();
  const hash = createHash('sha256').update(html).digest('hex');
  const event = finalizeEvent({ kind: 5129, created_at: 1_800_000_000, content: 'Snapshot',
    tags: [['x', hash]] }, new Uint8Array(32).fill(37));
  const link = neventEncode({ id: event.id, kind: 5129, author: event.pubkey });
  const lookupError = new Error('private relay diagnostics');
  const downloadError = new Error('private server diagnostics');
  const calls: string[] = [];
  let active = true;
  const coordinator = (source: PublishedSessionDependencies['source']) => createPublishedSessionCoordinator({
    database, sqlite, source, native: native(calls), newInstanceId: () => SESSION,
    lookupRelays: () => ['wss://relay.example.org'],
    identity: { sessionAuthority: () => ({ user: USER, epoch: 3, assertActive() {
      if (!active) throw new Error('private identity diagnostics');
    } }), getSnapshot: () => ({ session: { epoch: 3 } }) } as PublishedSessionDependencies['identity'],
  });
  const source = { query: async () => [event], readHtml: async () => html };
  const review = async () => assert.fail('an unverified napplet must not request consent');
  const outcomes = [
    { query: async () => { throw lookupError; }, code: 'PUBLISHED_LOOKUP_UNAVAILABLE', text: /could not complete its relay lookup/ },
    { query: async () => [], code: 'PUBLISHED_NOT_FOUND', text: /No matching signed publication/ },
    { readHtml: async () => { throw downloadError; }, code: 'PUBLISHED_DOWNLOAD_UNAVAILABLE', text: /could not download the napplet file/ },
    { readHtml: async () => new Uint8Array([0]), code: 'PUBLISHED_HASH_MISMATCH', text: /does not match the hash/ },
  ];
  for (const { code, text, ...override } of outcomes) {
    await assert.rejects(coordinator({ ...source, ...override }).openLink(link, new AbortController().signal, review), error => {
      assert.equal((error as { code?: string }).code, code);
      const message = publishedOpenFailureText(error);
      assert.match(message, text);
      assert.doesNotMatch(message, /private|wss:/);
      return true;
    });
  }

  const cancelled = new AbortController();
  await assert.rejects(coordinator({ ...source, query: async () => {
    cancelled.abort();
    throw lookupError;
  } }).openLink(link, cancelled.signal, review), { code: 'PUBLISHED_SESSION_FAILED' });
  await assert.rejects(coordinator({ ...source, readHtml: async () => {
    active = false;
    throw downloadError;
  } }).openLink(link, new AbortController().signal, review), { code: 'PUBLISHED_SESSION_FAILED' });
  assert.deepEqual(calls, []);
});

test('Settings uses generic copy for unknown and untrusted errors', () => {
  const fallback = 'The napplet could not be opened. Try again.';
  assert.equal(publishedOpenFailureText(new Error('raw native diagnostic')), fallback);
  assert.equal(publishedOpenFailureText({ code: 'PUBLISHED_LOOKUP_UNAVAILABLE', message: 'forged' }), fallback);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('raw proxy diagnostic'); } });
  assert.equal(publishedOpenFailureText(hostile), fallback);
});

test('restored exact pins retain prior game access and require approval before staging Intent', async t => {
  const {database, sqlite} = await setup(t);
  const html = getEmbeddedTestHtmlBytes(), hash = createHash('sha256').update(html).digest('hex');
  const makeEvent = (appId: string, domain: string, seed: number) => finalizeEvent({
    kind: 35129, created_at: 1_800_000_001, content: appId,
    tags: [['d', appId], ['x', hash], ['R', domain]],
  }, new Uint8Array(32).fill(seed));
  const game = makeEvent('saved-game', 'theme', 3);
  const handler = makeEvent('saved-handler', 'intent', 4);
  const register = async (event: typeof game, domain: string, id: string) => {
    const appId = event.tags[0]![1]!;
    const owner = registration({user: USER, publisher: event.pubkey, appId});
    const store = database.bindApp(owner).port;
    const review = JSON.stringify({profile: 'hypergolic-native-2026-11-06-v1', requested: [domain], domains: [domain]});
    await store.replaceAccessGrant([domain], null, {}, review);
    const manifest = await verifyManifest({kind: 35129, pubkey: event.pubkey, identifier: appId, relayHints: []}, event);
    return {store, review, descriptor: descriptorForPublishedArtifact(await verifyArtifact(manifest, html), id)};
  };
  const oldGame = await register(game, 'theme', SESSION);
  const oldHandler = await register(handler, 'intent', '911fab48-6875-4df7-94f4-62dafbfa03ac');
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(snapshotWorkspace(
    openNapplet(openNapplet(emptyWorkspace(), oldGame.descriptor), oldHandler.descriptor),
  ))));
  const calls: string[] = [];
  const service = createPublishedSessionCoordinator({database, sqlite, native: native(calls),
    newInstanceId: () => SESSION, lookupRelays: () => ['wss://relay.example.org'],
    identity: {sessionAuthority: () => ({user: USER, epoch: 1, assertActive() {}}),
      getSnapshot: () => ({session: {epoch: 1}})} as PublishedSessionDependencies['identity'],
    source: {query: async coordinate => {assert.equal(coordinate.kind,35129);return [coordinate.identifier === 'saved-game' ? game : handler];}, readHtml: async () => html},
  });
  const signal = new AbortController().signal;
  const loaded = await service.reopenPinned(restored.sessions[0]!, signal, async () => assert.fail('prior game grant must reopen'));
  assert.equal(loaded.descriptor.eventId, game.id); loaded.revoke();
  const before = calls.slice();
  await assert.rejects(service.reopenPinned(restored.sessions[1]!, signal, async request => {
    assert.equal(request.eventId, handler.id);
    assert.deepEqual(request.domains, ['intent']);
    return false;
  }));
  assert.deepEqual(calls, before);
  assert.equal((await oldHandler.store.readAccessGrant())?.supportReview, oldHandler.review);
  const accepted = await service.reopenPinned(restored.sessions[1]!, signal, async () => true);
  assert.deepEqual(JSON.parse(JSON.parse(accepted.hostInput).configuration).domains, ['intent']);
  accepted.revoke();
});

test('exact snapshots isolate same-HTML grants, data and cache across restore and refetch', async t => {
  const {database,sqlite}=await setup(t);
  const html=getEmbeddedTestHtmlBytes(), hash=createHash('sha256').update(html).digest('hex');
  const secret=new Uint8Array(32).fill(35);
  const sign=(created_at:number)=>finalizeEvent({kind:5129,created_at,content:'Immutable fixture',
    tags:[['x',hash],['title','Exact snapshot'],['R','storage'],['O','intent'],['A','35129:'+'1'.repeat(64)+':other']]},secret);
  const [first,second]=[sign(1),sign(2)];
  const lookups: unknown[]=[],calls:string[]=[];
  let hideExact=false;
  const ports:PublishedSessionDependencies={database,sqlite,newInstanceId:()=>SESSION,
    native:{...native(calls),beginPublishedSnapshot(_session,publisher,eventId,title,_version,htmlHash,length){
      assert.equal(publisher,first.pubkey);assert.equal(title,'Exact snapshot');assert.equal(htmlHash,hash);
      assert.equal(length,html.byteLength);calls.push(eventId);return 'snapshot-upload';
    }},
    identity:{sessionAuthority:()=>({user:USER,epoch:1,assertActive(){}}),
      getSnapshot:()=>({session:{epoch:1}})} as PublishedSessionDependencies['identity'],
    lookupRelays:()=>['wss://relay.example.org'],
    source:{async query(reference,relays,pin){
      assert.equal(reference.kind,5129);assert.deepEqual(relays,['wss://relay.example.org']);assert.equal(pin,null);
      lookups.push(reference);return hideExact?[second]:reference.eventId===first.id?[first,second]:[second];
    },async readHtml(expected){assert.equal(expected,hash);return html;}}};
  const coordinator=createPublishedSessionCoordinator(ports), signal=new AbortController().signal;
  const link=(event:typeof first)=>neventEncode({id:event.id,kind:5129,author:event.pubkey,relays:['wss://untrusted.example.org']});
  const one=await coordinator.openLink(link(first),signal,async review=>{
    assert.deepEqual(review.snapshot,{kind:5129,eventId:first.id,title:'Exact snapshot'});
    return true;
  });
  const claimed=JSON.parse(one.hostInput);
  assert.deepEqual(claimed.snapshot,JSON.parse(claimed.configuration).snapshot);
  assert.equal(claimed.appId,snapshotAppKey(first.id));
  assert.equal(claimed.eventId,first.id);
  const projection={...JSON.parse(claimed.configuration),generation:SESSION};
  assert.deepEqual(decodeNativeRegistration(projection).snapshot,claimed.snapshot);
  for(const patch of [{snapshot:undefined},{snapshot:{...claimed.snapshot,eventId:second.id}},
    {snapshot:{...claimed.snapshot,eventId:'a'.repeat(63)+'\n'}},{snapshot:{...claimed.snapshot,title:'Injected\nkind'}},
    {appId:claimed.appId.trim()},{fixture:'state-lab'},{legacyReadOnly:{}},{appData:{}}]){
    assert.throws(()=>decodeNativeRegistration({...projection,...patch}));
  }
  assert.equal(calls.includes('begin'),false);
  one.revoke();

  const named=registration({user:USER,publisher:first.pubkey,appId:snapshotAppKey(first.id).trim(),version:one.descriptor.version});
  const selected={...named,appId:one.descriptor.appId};
  await database.bindStorage(selected).port.set('only-here','exact');
  assert.equal(await database.bindStorage(named).port.get('only-here'),null);
  assert.equal(await database.bindStorage({...selected,appId:snapshotAppKey(second.id)}).port.get('only-here'),null);
  assert.equal(await database.bindApp(named).port.readAccessGrant(),null);
  const before=calls.slice();
  await assert.rejects(coordinator.openLink(link(second),signal,async review=>{
    assert.equal(review.snapshot?.eventId,second.id);return false;
  }));
  assert.deepEqual(calls,before);
  const persisted=await database.bindWorkspace({user:USER,assertActive(){}}).port.save(
    snapshotWorkspace(openNapplet(emptyWorkspace(),one.descriptor)),null);
  const pin=restoreWorkspace(persisted.snapshot).sessions[0]!;
  const reopened=await createPublishedSessionCoordinator(ports).reopenPinned(pin,signal,async()=>assert.fail('saved grant expected'));
  assert.equal(reopened.artifact.manifest.id,first.id);assert.equal(lookups.length,2);reopened.revoke();
  const cache=sqlite.raw(PUBLISHED_ARTIFACT_CACHE_DATABASE);
  cache.prepare('DELETE FROM verified_published_artifacts').run();
  hideExact=true;
  await assert.rejects(coordinator.reopenPinned(pin,signal,async()=>assert.fail('wrong event cannot reach review')));
  assert.deepEqual(lookups.at(-1),{kind:5129,eventId:first.id,pubkey:first.pubkey});
  await assert.rejects(coordinator.prepareUpdate(pin,signal,async()=>assert.fail('snapshot is immutable'),async()=>false));
});

test('unsupported requested capabilities warn without granting unsupported domains; denial prevents launch', async t => {
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
    assert.deepEqual(review.unsupportedDomains, ['webrtc']); return false;
  }));
  assert.deepEqual(calls, []);
  const opened = await service.openLink(link, new AbortController().signal, async review => {
    assert.deepEqual(review.domains, ['cvm', 'webrtc']);
    assert.deepEqual(review.unsupportedDomains, ['webrtc']); return true;
  });
  assert.deepEqual(JSON.parse(JSON.parse(opened.hostInput).configuration).domains, ['cvm']);
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

test('reopening an old display title refreshes it only after exact pin verification', async t => {
  const { database, sqlite } = await setup(t);
  const html = getEmbeddedTestHtmlBytes(), appId = 'n-26115e0d25b';
  const event = signedFixture(1_800_000_001, appId, html, ['theme'], new Uint8Array(32).fill(7), 'Murder Mice');
  const link = naddrEncode({ kind: 35129, pubkey: event.pubkey, identifier: appId });
  let workspace = emptyWorkspace();
  const store = {getSnapshot: () => ({workspace,error:null}), change: (next: typeof workspace) => { workspace = next; }};
  const identity = {
    sessionAuthority: () => ({ user: USER, epoch: 2, assertActive: () => undefined }),
    getSnapshot: () => ({ session: { epoch: 2, workspace: store } }),
  } as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const calls: string[] = [];
  const leases = Object.assign(new NativeLeases(), native(calls));
  const owner = createRuntimeOwner(database, identity, leases, undefined, {
    sqlite, native: leases, lookupRelays: () => ['wss://relay.example.org'],
    source: { query: async () => [event], readHtml: async () => new Uint8Array(html) },
  });
  const descriptor = await owner.openPublishedLink(link, new AbortController().signal, async () => true);
  assert.equal(descriptor.title, 'Murder Mice');
  owner.discardPublished(descriptor.id);
  const saved = {...descriptor, title: appId};
  const wrong = {...descriptor, eventId: 'f'.repeat(64)};
  workspace = openNapplet(workspace, wrong);
  await assert.rejects(owner.openPublished(wrong, new AbortController().signal, async () => assert.fail('wrong pin')));
  workspace = openNapplet(emptyWorkspace(), saved);
  const binding = await owner.openPublished(saved, new AbortController().signal, async () => assert.fail('remembered grant'));
  assert.deepEqual(workspace.sessions, [descriptor]);
  binding.ready('verified-generation');
  assert.equal(owner.publishedReadyGeneration(saved), 'verified-generation');
  assert.throws(() => owner.publishedReadyGeneration(wrong), {code:'REVOKED'});
  binding.revoke();
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
  const oldEvent = signedFixture(1_800_000_001, appId, originalHtml, ['theme'], key, 'Original title');
  const newEvent = signedFixture(1_800_000_002, appId, updatedHtml, ['theme'], key, 'Updated title');
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
  const oldPin = {...opened.descriptor, title: appId};
  latest = newEvent;
  await assert.rejects(service.prepareUpdate(oldPin, new AbortController().signal,
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
  const updated = await service.prepareUpdate(oldPin, new AbortController().signal,
    async request => { assert.equal(request.previousEventId, oldEvent.id); return true; }, async () => {
      assert.fail('unchanged capability grant must not be reviewed again');
    });
  assert(updated);
  assert.equal(updated.descriptor.eventId, newEvent.id);
  assert.equal(updated.descriptor.title, 'Updated title');
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

test('exact discovery review binds staging, then transfers lifetime to the mounted published session', async t => {
  const { database, sqlite } = await setup(t);
  let workspace = emptyWorkspace();
  const calls: string[] = [];
  const transfer = native(calls);
  let register = true;
  const leases = Object.assign(new NativeLeases(), transfer, {
    registerPublishedSession: (id: string) => register && transfer.registerPublishedSession(id),
  });
  const identity = {
    sessionAuthority: () => ({ user: USER, epoch: 1, assertActive: () => {} }),
    getSnapshot: () => ({ session: { epoch: 1, workspace: { getSnapshot: () => ({ workspace, error: null }) } } }),
  } as unknown as Pick<IdentityTransition, 'sessionAuthority' | 'getSnapshot'>;
  const owner = createRuntimeOwner(database, identity, leases, undefined, {
    sqlite, native: leases, lookupRelays: () => ['wss://relay.example.org'],
    networkRelays: () => ['wss://directory.example.org', 'wss://relay.example.org'],
    source: { query: async (_coordinate, relays, pinned, _signal, discovery) => {
      assert.equal(pinned, null);
      assert.equal(discovery, true);
      assert.deepEqual(relays, ['wss://relay.example.org', 'wss://directory.example.org']);
      return [EMBEDDED_TEST_EVENT];
    }, readHtml: async () => getEmbeddedTestHtmlBytes() },
  });
  let focused = true;
  const sourceActive = () => { if (!focused) throw new Error('Caller unfocused'); };
  const signal = new AbortController();
  const artifact = await owner.resolveDiscovered(LINK, EMBEDDED_TEST_EVENT.id, signal.signal, sourceActive);
  const busy = new ReviewBusyError();
  await assert.rejects(owner.prepareDiscovered(artifact, signal.signal, sourceActive, async changesAccess => {
    assert.equal(changesAccess, true);
    throw busy;
  }), error => error === busy);
  assert.deepEqual(calls, []);

  await assert.rejects(owner.prepareDiscovered(artifact, signal.signal, sourceActive, async changesAccess => {
    assert.equal(changesAccess, true);
    focused = false;
    return true;
  }));
  assert.deepEqual(calls, []);

  focused = true;
  const descriptor = await owner.prepareDiscovered(artifact, signal.signal, sourceActive, async changesAccess => {
    assert.equal(changesAccess, true);
    return true;
  });
  assert.equal(descriptor.eventId, EMBEDDED_TEST_EVENT.id);
  assert.deepEqual(calls, [`register:${descriptor.id}`, 'begin', 'append', 'finish']);
  workspace = openNapplet(workspace, descriptor);
  focused = false;
  signal.abort();
  const binding = await owner.openPublished(descriptor, new AbortController().signal, async () => {
    assert.fail('The exact prepared artifact already owns the reviewed grant');
  });
  assert.equal(owner.publishedReadyGeneration(descriptor), null);
  binding.ready('mounted-exact-target');
  assert.equal(owner.publishedReadyGeneration(descriptor), 'mounted-exact-target');
  binding.revoke();
  assert.equal(owner.publishedReadyGeneration(descriptor), null);

  focused = true;
  await assert.rejects(owner.prepareDiscovered(artifact, new AbortController().signal, sourceActive, async changesAccess => {
    assert.equal(changesAccess, false);
    throw busy;
  }, descriptor), error => error === busy);
  assert.equal(calls.filter(call => call.startsWith('register:')).length, 1);

  await assert.rejects(owner.prepareDiscovered(artifact, new AbortController().signal, sourceActive, async changesAccess => {
    assert.equal(changesAccess, false);
    return false;
  }, descriptor));
  register = false;
  await assert.rejects(owner.prepareDiscovered(artifact, new AbortController().signal, sourceActive, async () => true, descriptor),
    {code: 'PUBLISHED_TRANSFER_FAILED'});
  assert.equal(calls.filter(call => call.startsWith('register:')).length, 1);
});
