import assert from 'node:assert/strict';
import test from 'node:test';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {createIdentityDataService} from '../../src/identity/identity-service.ts';
import {openIdentityCache} from '../../src/identity/identity-cache.ts';
import {IDENTITY_LIMITS} from '../../src/identity/identity-contract.ts';
import {createProfileAvatarReader} from '../../src/identity/profile-avatar-image.ts';
import {bindProfileAvatarOwner, createProfileAvatarStore} from '../../src/identity/profile-avatar.ts';
import type {NativePublishedHttpsPort} from '../../src/napplets/native-published-https.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import type {TransitionSnapshot} from '../../src/security/identity-transition.ts';
import {DiskSQLite, deferred, hex} from '../storage/harness.ts';
const secret = new Uint8Array(32); secret[31] = 1;
const user = getPublicKey(secret), other = hex(9);
const picture = 'https://files.example.org/avatar.png';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
const uuid = '11111111-1111-4111-8111-111111111111';
const signal = () => new AbortController().signal;
const active = () => {};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
const native = (fetch: NativePublishedHttpsPort['fetchPublishedHttps']): NativePublishedHttpsPort => ({newInstanceId: () => uuid, fetchPublishedHttps: fetch, cancelPublishedHttps() {}, revokeAllPublishedHttps() {}});
const profileEvent = (content: unknown, created_at = 10) => JSON.parse(JSON.stringify(finalizeEvent({kind: 0, content: JSON.stringify(content), tags: [], created_at}, secret)));
async function cacheFor(t: {after(fn: () => void): void}) {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  return {sqlite, cache: await openIdentityCache(sqlite, 'android')};
}

test('ordinary host profile and guest profile share verified SQLite data without a synthetic registration', async t => {
  const {cache} = await cacheFor(t); let queries = 0;
  const profiles = createIdentityDataService(cache, {async query(filters) {queries++; assert.deepEqual(filters[0]!.authors, [user]); return [{event: profileEvent({picture})}];}}, () => 1000);
  const store = createProfileAvatarStore(profiles, createProfileAvatarReader(native(async (operation, url) => {assert.equal(operation, uuid); assert.equal(url, picture); return png;})));
  t.after(() => store.dispose());
  store.setIdentity(user, 0, true); store.setForeground(true);
  for (let n = 0; n < 50 && !store.getSnapshot()?.avatar; n++) await tick();
  assert.deepEqual(store.getSnapshot(), {user, epoch: 0, avatar: {uri: `data:image/png;base64,${png}`, cacheKey: uuid}});
  const registration: NativeRegistration = {user, publisher: hex(2), appId: 'state-lab', version: hex(3), instanceId: 'one', sessionId: 'one', generation: 'one', epoch: 0, fixture: 'state-lab', domains: ['identity']};
  const reply = await profiles.read({type: 'identity.getProfile', id: 'guest'}, registration, signal(), active);
  assert.deepEqual(reply.profile, {picture}); assert.equal(queries, 1);
});

test('app-only host profile still rejects wrong authors, malformed signed metadata and forged signatures', async t => {
  const {cache} = await cacheFor(t);
  for (const [owner, event] of [[other, profileEvent({picture})], [user, profileEvent({picture: 42})], [user, {...profileEvent({picture}), sig: '0'.repeat(128)}]] as const) {
    const profiles = createIdentityDataService(cache, {async query() {return [{event}];}}, () => 1000);
    await assert.rejects(profiles.readProfile(owner, signal(), active));
  }
});

test('newer signed empty profile removes the avatar URL; cold verified cache remains identity scoped', async t => {
  const {cache, sqlite} = await cacheFor(t);
  const first = createIdentityDataService(cache, {async query() {return [{event: profileEvent({picture})}];}}, () => 1000);
  assert.deepEqual(await first.readProfile(user, signal(), active), {picture}); await cache.close();
  const reopened = await openIdentityCache(sqlite, 'android');
  const cold = createIdentityDataService(reopened, {async query() {throw Error('fresh cache must avoid network');}}, () => 1001);
  assert.deepEqual(await cold.readProfile(user, signal(), active), {picture});
  await assert.rejects(cold.readProfile(other, signal(), active));
  const cleared = createIdentityDataService(reopened, {async query() {return [{event: profileEvent({}, 20)}];}}, () => 1001 + IDENTITY_LIMITS.freshMs);
  assert.deepEqual(await cleared.readProfile(user, signal(), active), {});
});

for (const url of ['http://files.example.org/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://name:secret@files.example.org/a', 'https://files.example.org/a#fragment', 'data:image/png;base64,' + png, 'https://files.example.org/\\a']) test(`profile image preflight rejects ${url.split(':')[0]} input before native I/O`, async () => {
  let called = false;
  const read = createProfileAvatarReader(native(async () => {called = true; return png;}));
  await assert.rejects(read(url, signal(), active)); assert.equal(called, false);
});

for (const [name, encoded] of [['noncanonical', png.slice(0, -1)], ['HTML', Buffer.from('<svg/>').toString('base64')], ['unknown bytes', Buffer.from([0, 1, 2]).toString('base64')], ['oversize', Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')]] as const) test(`profile image rejects ${name} body`, async () => {
  await assert.rejects(createProfileAvatarReader(native(async () => encoded))(picture, signal(), active));
});

test('raster admission rejects oversized canvas before platform codec decode', async () => {
  const bytes = Buffer.from(png, 'base64'); bytes.writeUInt32BE(4097, 16);
  await assert.rejects(createProfileAvatarReader(native(async () => bytes.toString('base64')))(picture, signal(), active));
});

test('native failure and cancellation never return image bytes; cancelling targets only the captured operation', async () => {
  await assert.rejects(createProfileAvatarReader(native(async () => {throw Error('network refused');}))(picture, signal(), active));
  const held = deferred(); let cancelled = '';
  const port = native(async () => {await held.promise; return png;}); port.cancelPublishedHttps = operation => {cancelled = operation;};
  const controller = new AbortController(); const pending = createProfileAvatarReader(port)(picture, controller.signal, active);
  controller.abort(); held.resolve(); await assert.rejects(pending); assert.equal(cancelled, uuid);
  let called = false; controller.abort();
  await assert.rejects(createProfileAvatarReader(native(async () => {called = true; return png;}))(picture, controller.signal, active));
  assert.equal(called, false);
});

for (const boundary of ['identity', 'epoch', 'unavailable', 'background', 'dispose'] as const) test(`avatar ${boundary} boundary aborts profile work and rejects late delivery`, async () => {
  const held = deferred(); let oldSignal: AbortSignal | undefined;
  const store = createProfileAvatarStore({async readProfile(owner, requestSignal) {
    if (owner === other) return null;
    oldSignal = requestSignal; await held.promise; return {picture};
  }}, async () => {throw Error('stale profile must not reach image I/O');});
  store.setIdentity(user, 0, true); store.setForeground(true); await tick(); assert.ok(oldSignal);
  if (boundary === 'identity') store.setIdentity(other, 1, true);
  if (boundary === 'epoch') store.setIdentity(user, 1, false);
  if (boundary === 'unavailable') store.setIdentity(user, 0, false);
  if (boundary === 'background') store.setForeground(false);
  if (boundary === 'dispose') store.dispose();
  assert.equal(oldSignal.aborted, true); held.resolve(); await tick();
  assert.equal(store.getSnapshot()?.avatar, undefined); store.dispose();
});

test('late native image from the old identity cannot replace the selected fallback', async () => {
  const held = deferred(); let imageSignal: AbortSignal | undefined;
  const store = createProfileAvatarStore({async readProfile(owner) {return owner === user ? {picture} : null;}}, async (_, requestSignal) => {imageSignal = requestSignal; await held.promise; return {uri: `data:image/png;base64,${png}`, cacheKey: uuid};});
  store.setIdentity(user, 0, true); store.setForeground(true); await tick(); assert.ok(imageSignal);
  store.setIdentity(other, 1, true); assert.equal(imageSignal.aborted, true); held.resolve(); await tick();
  assert.deepEqual(store.getSnapshot(), {user: other, epoch: 1}); store.dispose();
});

for (const failure of ['missing', 'profile', 'image'] as const) test(`avatar ${failure} failure remains a stable local fallback`, async () => {
  const store = createProfileAvatarStore({async readProfile() {if (failure === 'profile') throw Error('invalid profile'); return failure === 'missing' ? null : {picture};}}, async () => {throw Error('invalid image');});
  store.setIdentity(user, 0, true); store.setForeground(true); const before = store.getSnapshot(); await tick();
  assert.equal(store.getSnapshot(), before); assert.deepEqual(before, {user, epoch: 0}); store.dispose();
});

test('foreground return obtains a replacement source for the same identity after image failure', async () => {
  let calls = 0, url = picture; const images: string[] = [];
  const store = createProfileAvatarStore({async readProfile() {calls++; return {picture: url};}}, async destination => {images.push(destination); if (images.length === 1) throw Error('broken image'); return {uri: `data:image/png;base64,${png}`, cacheKey: uuid};});
  store.setIdentity(user, 0, true); store.setForeground(true); await tick(); assert.equal(store.getSnapshot()?.avatar, undefined);
  store.setForeground(true); store.setIdentity(user, 0, true); assert.equal(calls, 1, 'unchanged lifecycle cannot duplicate work');
  url = 'https://files.example.org/new.png'; store.setForeground(false); store.setForeground(true); await tick();
  assert.deepEqual(images, [picture, url]); assert.ok(store.getSnapshot()?.avatar); const source = store.getSnapshot()!.avatar;
  store.setForeground(false); store.setForeground(true); await tick(); assert.notEqual(store.getSnapshot()?.avatar, source, 'new source can recover an Image codec failure for the same npub');
  store.dispose();
});

test('owner synchronization cancels immediately on transition, without waiting for a React effect', async () => {
  let state = {phase: 'ready', session: {epoch: 0, vault: {selectedPubkey: user}}} as TransitionSnapshot;
  const listeners = new Set<() => void>(), held = deferred(); let captured: AbortSignal | undefined;
  const store = createProfileAvatarStore({async readProfile(_, requestSignal) {captured = requestSignal; await held.promise; return null;}}, async () => {throw Error('unexpected image');});
  const release = bindProfileAvatarOwner({getSnapshot: () => state, subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};}}, store);
  store.setForeground(true); await tick(); assert.ok(captured);
  state = {...state, phase: 'switching'}; for (const listener of listeners) listener(); assert.equal(captured.aborted, true);
  release(); held.resolve(); await tick(); assert.equal(store.getSnapshot(), null); assert.equal(listeners.size, 0);
});


test('immediate foreground return waits for cancelled shared profile admission to release', async t => {
  const {cache} = await cacheFor(t), held = deferred(); let calls = 0;
  const profiles = createIdentityDataService(cache, {async query() {calls++; if (calls === 1) await held.promise; return [{event: profileEvent({picture})}];}}, () => 1000);
  const store = createProfileAvatarStore(profiles, createProfileAvatarReader(native(async () => png)));
  t.after(() => store.dispose()); store.setIdentity(user, 0, true); store.setForeground(true);
  for (let n = 0; n < 50 && calls === 0; n++) await tick(); assert.equal(calls, 1);
  store.setForeground(false); store.setForeground(true);
  for (let n = 0; n < 50 && !store.getSnapshot()?.avatar; n++) await tick();
  assert.ok(store.getSnapshot()?.avatar, 'cancelled old read cannot leave foreground stuck on identity-data-busy fallback');
  assert.equal(calls, 2); held.resolve(); await tick(); assert.ok(store.getSnapshot()?.avatar);
});


test('identical image bytes receive distinct native operation keys on reread', async () => {
  let sequence = 0;
  const port = native(async () => png); port.newInstanceId = () => sequence++ === 0 ? uuid : uuid.slice(0, -1) + '2';
  const read = createProfileAvatarReader(port), first = await read(picture, signal(), active), next = await read(picture, signal(), active);
  assert.equal(first.uri, next.uri); assert.notEqual(first.cacheKey, next.cacheKey);
});
