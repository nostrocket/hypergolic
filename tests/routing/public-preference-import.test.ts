import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { verifiedPublicationIdentity } from '../../src/napplets/verified-publication-identity.ts';
import type { RelayQueryResult } from '../../src/network/native-relay-query.ts';
import { openRoutingCatalog } from '../../src/routing/routing-catalog.ts';
import { createPublicPreferenceImport } from '../../src/routing/public-preference-import.ts';
import { PublicPreferenceError } from '../../src/routing/public-preference-plan.ts';
import { ReviewSlot } from '../../src/shell/review-slot.ts';
import { ShellStorageError } from '../../src/storage/ports.ts';
import { deferred, DiskSQLite } from '../storage/harness.ts';
import { modernHandler, snapshotHandler } from './fixtures.ts';

const role = 'napptest';
const secret = new Uint8Array(32).fill(23);
const account = getPublicKey(secret);
const otherSecret = new Uint8Array(32).fill(24);
const otherAccount = getPublicKey(otherSecret);
const owner = { user: account, assertActive() {} };
const namedRef = (publisher: string, identifier: string) => `35129:${publisher}:${identifier}`;

function signed(choices: string[][], created_at = 1_800_000_000, signer = secret, content = ''): NostrEvent {
  const event = finalizeEvent({kind: 31129, created_at, content, tags: [['d', role], ...choices]}, signer);
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

async function fixture(t: TestContext) {
  const sqlite = new DiskSQLite();
  const catalog = await openRoutingCatalog(sqlite, 'ios');
  const state = { user: account, epoch: 2, revision: 3, available: true, ownerAvailable: true, foreground: true };
  const clock = { now: 0 };
  const settings = { relays: ['wss://relay.example.org'] };
  const lookup = { result: {events: [], incomplete: false} as RelayQueryResult,
    wait: async (_signal: AbortSignal) => {} };
  const notifications = {updates: [] as string[][], fail: false};
  const source = { getSnapshot: () => ({current: null}), subscribe: () => () => {} };
  const slot = new ReviewSlot(source, source, () => state.epoch, () => () => {});
  t.after(async () => { slot.dispose(); try { await catalog.close(); } finally { sqlite.cleanup(); } });
  // Only the app-owned import path is under test. Native and WSS ports are doubles.
  const unused = () => assert.fail('import must not use a guest route or perform a delivery');
  const service = createPublicPreferenceImport({
    identity: { sessionAuthority() {
      const {user, epoch} = state;
      return {user, epoch, assertActive() {
        if (state.user !== user || state.epoch !== epoch) throw new ShellStorageError('REVOKED');
      }};
    }},
    native: { state: () => ({...state}), mayDeliver: unused, mayReview: unused, reviewRevision: unused,
      send: unused, subscribe: unused, newChannelId: unused },
    catalog, slot, relays: () => settings.relays, now: () => clock.now,
    broker: { async catalogChanged(active, roles, options) {
      active.assertActive();
      assert.deepEqual(options, {readOnly: true});
      notifications.updates.push([...(roles ?? [])]);
      if (notifications.fail) throw new Error('notification unavailable');
    } },
    queries: { query: unused, async queryDetailed(filters, signal, active) {
      active();
      assert.deepEqual(filters, [{kinds: [31129], authors: [state.user], limit: 32}]);
      await lookup.wait(signal);
      active();
      return lookup.result;
    }},
  });
  const use = (...events: NostrEvent[]) => { lookup.result = {events: events.map(event => ({event})), incomplete: false}; };
  const defaults = async () => (await catalog.inspect(owner)).defaults;
  return { catalog, service, use, defaults, lookup, state, settings, slot, updates: notifications.updates, notifications, clock, sqlite };
}

test('only selected-account signed records can produce an actionable import preview', async t => {
  const h = await fixture(t);
  const artifact = await modernHandler();
  const publication = verifiedPublicationIdentity(artifact.manifest);
  await h.catalog.remember(owner, artifact);
  const ref = namedRef(artifact.manifest.pubkey, publication.appId);
  const valid = signed([['a', ref]]);
  const forged = {...valid, sig: '0'.repeat(128)};
  for (const event of [signed([['a', ref]], valid.created_at, otherSecret), forged, {...valid, content: 'tampered'}]) {
    h.use(event);
    await assert.rejects(h.service.preview(), PublicPreferenceError);
    assert.equal(h.slot.getSnapshot(), null);
  }
  assert.deepEqual(await h.defaults(), []);
  assert.deepEqual(h.updates, []);
});

test('newest invalid choice stays unavailable and a lower-ranked choice is never promoted', async t => {
  const h = await fixture(t);
  const installed = await modernHandler();
  await h.catalog.remember(owner, installed);
  const ref = namedRef(installed.manifest.pubkey, verifiedPublicationIdentity(installed.manifest).appId);
  const previous = signed([['a', ref]]);
  for (const entries of [[['a', 'malformed'], ['a', ref]], [['e', '01'.repeat(32)], ['a', ref]]]) {
    const newest = signed(entries, previous.created_at + 1);
    h.use(newest, previous);
    const review = await h.service.preview();
    assert.equal(review.rows.length, 1);
    const row = review.rows[0]!;
    assert.equal(row.eventId, newest.id);
    assert.equal(row.target, null);
    assert(row.unavailableReason);
    await assert.rejects(h.service.accept(review, row.id), {code: 'INVALID_INPUT'});
    assert.equal(h.slot.getSnapshot(), null);
    assert.deepEqual(await h.defaults(), []);
  }
});

test('empty, action-only, root, and INC-only preferences leave the existing default unchanged', async t => {
  const h = await fixture(t);
  const [named, incOnly] = await Promise.all([modernHandler(), snapshotHandler(['inc'])]);
  const key = {publisher: named.manifest.pubkey, appId: verifiedPublicationIdentity(named.manifest).appId};
  await h.catalog.remember(owner, named);
  await h.catalog.remember(owner, incOnly);
  await h.catalog.prefer(owner, role, key);
  const action = ['i', 'napplet:napptest/open', namedRef(key.publisher, key.appId)];
  for (const choices of [[], [action], [['a', `15129:${key.publisher}:`]], [['e', incOnly.manifest.eventId]]]) {
    h.use(signed(choices));
    const review = await h.service.preview();
    const row = review.rows[0]!;
    assert.equal(row.current?.appId, key.appId);
    assert.equal(row.target, null);
    if (choices[0] === action) assert.deepEqual(row.ignoredActions, [action[1] + ' → ' + action[2]]);
    await assert.rejects(h.service.accept(review, row.id), {code: 'INVALID_INPUT'});
    assert.deepEqual(await h.defaults(), [{archetype: role, ...key}]);
  }
  assert.deepEqual(h.updates, []);
});

test('explicit review resolves exact named and snapshot pins without writing until acceptance', async t => {
  const h = await fixture(t);
  const [named, lookalike, snapshot, other] = await Promise.all([
    modernHandler(), modernHandler(undefined, ['intent'], 11), snapshotHandler(), snapshotHandler(['intent'], 1_800_000_001),
  ]);
  for (const artifact of [named, lookalike, snapshot, other]) await h.catalog.remember(owner, artifact);
  assert.equal(snapshot.htmlHash, other.htmlHash);
  assert.equal(named.htmlHash, snapshot.htmlHash);
  const namedId = verifiedPublicationIdentity(named.manifest).appId;
  const snapshotId = verifiedPublicationIdentity(snapshot.manifest).appId;
  const ref = namedRef(named.manifest.pubkey, namedId);
  h.use(signed([['a', ref], ['e', other.manifest.id], ['a', ref],
    ['i', 'napplet:napptest/open', snapshot.manifest.id]], undefined, undefined, 'Opaque signed metadata'));
  const firstCall = h.sqlite.calls.length;
  const namedReview = await h.service.preview();
  assert.equal(h.sqlite.calls.slice(firstCall).some(call => /^(?:INSERT|UPDATE|DELETE) /.test(call.sql)), false);
  const namedRow = namedReview.rows[0]!;
  assert.equal(namedReview.account, account);
  assert.deepEqual(namedRow.references, [ref, other.manifest.id]);
  assert.deepEqual(namedRow.ignoredActions, ['napplet:napptest/open → ' + snapshot.manifest.id]);
  assert.equal(namedRow.target?.eventId, named.manifest.id);
  assert.equal(namedRow.current, null);
  assert.equal(h.slot.getSnapshot()?.lane, 'routing');
  assert.deepEqual(await h.defaults(), []);
  await assert.rejects(h.service.accept({...namedReview}, namedRow.id), {code: 'REVOKED'});
  assert.deepEqual(await h.defaults(), []);
  const namedSaved = await h.service.accept(namedReview, namedRow.id);
  assert.equal(namedSaved.status, 'saved');
  assert.equal(namedSaved.snapshot.defaults[0]?.appId, namedId);
  await assert.rejects(h.service.accept(namedReview, namedRow.id), {code: 'REVOKED'});

  h.use(signed([['e', snapshot.manifest.id], ['e', other.manifest.id]]));
  const snapshotReview = await h.service.preview();
  const row = snapshotReview.rows[0]!;
  assert.equal(row.current?.eventId, named.manifest.id);
  assert.equal(row.target?.eventId, snapshot.manifest.id);
  assert.equal((await h.defaults())[0]?.appId, namedId);
  const snapshotSaved = await h.service.accept(snapshotReview, row.id);
  assert.equal(snapshotSaved.status, 'saved');
  assert.equal(snapshotSaved.snapshot.defaults[0]?.appId, snapshotId);
  assert.deepEqual(h.updates, [[role], [role]]);
  assert.equal(h.slot.getSnapshot(), null);
});

test('incomplete reads, aborts and a busy review slot preserve defaults', async t => {
  const h = await fixture(t);
  const artifact = await modernHandler();
  await h.catalog.remember(owner, artifact);
  const event = signed([['a', namedRef(artifact.manifest.pubkey, 'modern-handler')]]);
  h.lookup.result = {events: [{event}], incomplete: true};
  await assert.rejects(h.service.preview(), /did not complete/);
  h.use(event);
  const abort = new AbortController();
  const entered = deferred(), release = deferred();
  h.lookup.wait = async () => {entered.resolve(); await release.promise;};
  const reading = h.service.preview({signal: abort.signal});
  await entered.promise;
  assert.equal(h.slot.getSnapshot()?.lane, 'routing');
  abort.abort(); release.resolve();
  await assert.rejects(reading, {code: 'REVOKED'});

  h.lookup.wait = async () => assert.fail('a busy review must prevent lookup');
  assert(h.slot.reserveRouting({id: 'other-review', origin: {sessionId: 'other', generation: 'other', epoch: h.state.epoch}}));
  await assert.rejects(h.service.preview(), /Another review is open/);
  assert(h.slot.owns('routing', 'other-review'));
  h.slot.releaseRouting('other-review');
  h.lookup.wait = async () => {};
  const reviewing = new AbortController();
  const preview = await h.service.preview({signal: reviewing.signal});
  reviewing.abort();
  await assert.rejects(h.service.accept(preview, preview.rows[0]!.id), {code: 'REVOKED'});
  assert.equal(h.slot.getSnapshot(), null);
  assert.deepEqual(await h.defaults(), []);
});

test('a reviewed change expires or is revoked by identity, native revision, settings or explicit cancel', async t => {
  const h = await fixture(t);
  const artifact = await modernHandler();
  await h.catalog.remember(owner, artifact);
  h.use(signed([['a', namedRef(artifact.manifest.pubkey, 'modern-handler')]]));
  for (const revoke of [
    () => {h.state.user = otherAccount;}, () => {h.state.revision++;},
    () => {h.settings.relays = ['wss://other.example.org'];}, () => {h.clock.now += 300_000;},
  ]) {
    const preview = await h.service.preview();
    revoke();
    await assert.rejects(h.service.accept(preview, preview.rows[0]!.id), {code: 'REVOKED'});
    h.state.user = account;
    assert.equal(h.slot.getSnapshot(), null);
    assert.deepEqual(await h.defaults(), []);
  }
  const preview = await h.service.preview();
  h.service.cancel(preview);
  await assert.rejects(h.service.accept(preview, preview.rows[0]!.id), {code: 'REVOKED'});
  assert.deepEqual(h.updates, []);
});

test('acceptance fails if the current default or exact named target changed after review', async t => {
  const h = await fixture(t);
  const [named, snapshot] = await Promise.all([modernHandler(), snapshotHandler()]);
  await h.catalog.remember(owner, named);
  await h.catalog.remember(owner, snapshot);
  h.use(signed([['a', namedRef(named.manifest.pubkey, 'modern-handler')]]));
  const first = await h.service.preview();
  const selected = {publisher: snapshot.manifest.pubkey, appId: verifiedPublicationIdentity(snapshot.manifest).appId};
  await h.catalog.prefer(owner, role, selected);
  await assert.rejects(h.service.accept(first, first.rows[0]!.id), {code: 'REVOKED'});

  const second = await h.service.preview();
  const replacement = await modernHandler([['z', role], ['i', 'napplet:napptest/open'], ['title', 'New named revision']]);
  assert.notEqual(replacement.manifest.id, second.rows[0]!.target?.eventId);
  assert.equal(replacement.aggregateHash, second.rows[0]!.target?.version);
  await h.catalog.remember(owner, replacement);
  await assert.rejects(h.service.accept(second, second.rows[0]!.id), {code: 'INVALID_INPUT'});
  assert.deepEqual(await h.defaults(), [{archetype: role, ...selected}]);
  assert.deepEqual(h.updates, []);
});

test('failed notification reports the committed save and leaves the default durable', async t => {
  const h = await fixture(t);
  const named = await modernHandler();
  await h.catalog.remember(owner, named);
  h.use(signed([['a', namedRef(named.manifest.pubkey, 'modern-handler')]]));
  const preview = await h.service.preview(), row = preview.rows[0]!;
  h.notifications.fail = true;
  assert.deepEqual(await h.service.accept(preview, row.id), {status: 'saved-refresh-failed'});
  assert.deepEqual(h.updates, [[role]]);
  assert.equal(h.slot.getSnapshot(), null);
  await assert.rejects(h.service.accept(preview, row.id), {code: 'REVOKED'});
  const reopened = await openRoutingCatalog(h.sqlite, 'ios');
  try { assert.equal((await reopened.inspect(owner)).defaults[0]?.appId, 'modern-handler'); }
  finally { await reopened.close(); }
});
