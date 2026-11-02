import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { openPublishedArtifactCache, PUBLISHED_ARTIFACT_CACHE_DATABASE } from '../../src/napplets/published-artifact-cache.ts';
import { registration } from '../storage/harness.ts';
import { DiskSQLite } from '../storage/harness.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 27;
const publisher = getPublicKey(SECRET), user = '12'.repeat(32), html = new TextEncoder().encode('<!doctype html><html><head><title>Cache</title></head><body>ok</body></html>');
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }
async function makeArtifact(identifier = 'cached') {
  const htmlHash = await sha(html), aggregate = await sha(new TextEncoder().encode(`${htmlHash} /index.html\n`));
  const event = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '', tags: [
    ['d', identifier], ['path', '/index.html', htmlHash], ['x', aggregate, 'aggregate'], ['requires', 'theme'],
  ] }, SECRET);
  const coordinate = resolveNappletLink(naddrEncode({ kind: 35129, pubkey: publisher, identifier }));
  return verifyArtifact(await verifyManifest(coordinate, JSON.parse(JSON.stringify(event))), html);
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('persists bytes separately and re-verifies the original event and HTML on every read', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' }), epoch = { value: 4 };
  const authority = { owner, epoch: 4, currentEpoch: () => epoch.value };
  const artifact = await makeArtifact();
  const cache = await openPublishedArtifactCache(sqlite, authority);
  await cache.put(artifact);
  const reopened = await cache.get('cached', artifact.manifest.eventId);
  assert.ok(reopened);
  assert.deepEqual(reopened.htmlBytes, html);
  assert.equal(reopened.manifest.eventId, artifact.manifest.eventId);
  assert.equal(await cache.get('cached', 'ab'.repeat(32)), null);
  await cache.close();

  const db = new DatabaseSync(`${sqlite.directory}/${PUBLISHED_ARTIFACT_CACHE_DATABASE}`);
  const row = db.prepare('SELECT signed_event, html FROM verified_published_artifacts').get() as { signed_event: string; html: Uint8Array };
  assert.equal(JSON.parse(row.signed_event).sig, artifact.manifest.sig);
  assert.ok(row.html instanceof Uint8Array);
  db.close();
  const again = await openPublishedArtifactCache(sqlite, authority);
  assert.ok(await again.get('cached', artifact.manifest.eventId));
  await again.close();
});

test('duplicate put atomically replaces the cache row', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' });
  const artifact = await makeArtifact();
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 1, currentEpoch: () => 1 });
  await cache.put(artifact);
  await cache.put(artifact);
  assert.ok(await cache.get('cached', artifact.manifest.eventId));
  const db = new DatabaseSync(`${sqlite.directory}/${PUBLISHED_ARTIFACT_CACHE_DATABASE}`);
  assert.equal((db.prepare('SELECT count(*) AS count FROM verified_published_artifacts').get() as { count: number }).count, 1);
  db.close();
  await cache.close();
});

test('tampered database bytes are rejected and evicted instead of being trusted', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' });
  const artifact = await makeArtifact();
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 1, currentEpoch: () => 1 });
  await cache.put(artifact);
  const db = new DatabaseSync(`${sqlite.directory}/${PUBLISHED_ARTIFACT_CACHE_DATABASE}`);
  db.prepare('UPDATE verified_published_artifacts SET html = ?').run(new TextEncoder().encode('<!doctype html><html><head></head><body>forged</body></html>'));
  db.close();
  assert.equal(await cache.get('cached', artifact.manifest.eventId), null);
  const check = new DatabaseSync(`${sqlite.directory}/${PUBLISHED_ARTIFACT_CACHE_DATABASE}`);
  assert.equal(check.prepare('SELECT count(*) AS count FROM verified_published_artifacts').get()?.count, 0);
  check.close();
  await cache.close();
});

test('identity epoch change cancels pending cache read and subsequent writes', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' }), epoch = { value: 8 };
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 8, currentEpoch: () => epoch.value });
  const entered = deferred(), release = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('SELECT publisher')) { entered.resolve(); await release.promise; } };
  const artifact = await makeArtifact(); await cache.put(artifact);
  const read = cache.get('cached', artifact.manifest.eventId);
  await entered.promise; epoch.value++; release.resolve();
  await assert.rejects(read, error => (error as { code?: string }).code === 'REVOKED');
  await assert.rejects(cache.put(artifact), error => (error as { code?: string }).code === 'REVOKED');
});

test('abort signal and explicit revocation cancel queued operations', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' }), artifact = await makeArtifact();
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 2, currentEpoch: () => 2 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.get('cached', artifact.manifest.eventId, { signal: controller.signal }), error => (error as { code?: string }).code === 'CANCELLED');
  cache.revoke();
  await assert.rejects(cache.get('cached', artifact.manifest.eventId), error => (error as { code?: string }).code === 'REVOKED');
});

test('selected app must equal signed d identifier for reads and writes', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'other' }), artifact = await makeArtifact('cached');
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 2, currentEpoch: () => 2 });
  await assert.rejects(cache.put(artifact), error => (error as { code?: string }).code === 'INVALID_INPUT');
  await assert.rejects(cache.get('cached', artifact.manifest.eventId), error => (error as { code?: string }).code === 'INVALID_INPUT');
  await cache.close();
});

test('selected app mutation during awaited I/O revokes the cache operation', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const owner = registration({ user, publisher, appId: 'cached' });
  const cache = await openPublishedArtifactCache(sqlite, { owner, epoch: 2, currentEpoch: () => 2 });
  const entered = deferred(), release = deferred();
  sqlite.onStep = async sql => { if (sql.startsWith('SELECT publisher')) { entered.resolve(); await release.promise; } };
  const artifact = await makeArtifact(); await cache.put(artifact);
  const read = cache.get('cached', artifact.manifest.eventId);
  await entered.promise;
  (owner as { appId: string }).appId = 'substituted'; release.resolve();
  await assert.rejects(read, error => (error as { code?: string }).code === 'REVOKED');
  await cache.close();
});

test('reopen rejects an altered cache schema', async t => {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const db = new DatabaseSync(`${sqlite.directory}/${PUBLISHED_ARTIFACT_CACHE_DATABASE}`);
  db.exec('PRAGMA user_version = 1; CREATE TABLE verified_published_artifacts (unexpected TEXT)'); db.close();
  const owner = registration({ user, publisher, appId: 'cached' });
  await assert.rejects(openPublishedArtifactCache(sqlite, { owner, epoch: 1, currentEpoch: () => 1 }),
    error => (error as { code?: string }).code === 'CORRUPT_STORAGE');
});
