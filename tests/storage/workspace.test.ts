import test from 'node:test';
import assert from 'node:assert/strict';
import { openShellDatabase } from '../../src/storage/database.ts';
import { snapshot, utf8Bytes } from '../../src/storage/codec.ts';
import { emptyWorkspace, restoreWorkspace, snapshotWorkspace, type NappletDescriptor, type WorkspaceSnapshot } from '../../src/shell/workspace.ts';
import { assertWorkspaceAvailability } from '../../src/shell/fixtures.ts';
import { assertCode, deferred, hex, registration, setup } from './harness.ts';
export function descriptor(id: string, patch: Partial<NappletDescriptor> = {}): NappletDescriptor {
  return { id, title: id, publisher: hex(2), appId: 'test-app', version: hex(3), source: 'published', eventId: hex(4), ...patch };
}
export const sample = (): WorkspaceSnapshot => ({ schema: 1, sessions: [descriptor('third'), descriptor('first'), descriptor('second')], lastActiveId: 'first' });

test('workspace row distinguishes absent from explicit empty across process-style reopen', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindWorkspace(registration()).port;
  assert.equal(await port.load(), null);
  const record = await port.save(snapshotWorkspace(emptyWorkspace()), null);
  assert.equal(record.revision, 0); assert.deepEqual(restoreWorkspace(record.snapshot), emptyWorkspace());
  await database.close(); const reopened = await openShellDatabase(sqlite, 'ios');
  const actual = await reopened.bindWorkspace(registration()).port.load();
  assert(actual); assert.equal(actual.revision, 0); assert.deepEqual(actual.snapshot.sessions, []); assert.equal(actual.snapshot.lastActiveId, null);
  assert.equal(await reopened.bindWorkspace(registration({ user: hex(9) })).port.load(), null);
});

test('workspace restore preserves exact opening order, focused instance and unsigned fixture descriptors', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindWorkspace(registration()).port;
  const fixture: NappletDescriptor = { id: 'fixture', title: 'UX Lab', source: 'bundled', publisher: 'bundled-unsigned-fixture', appId: 'test-app', version: hex(3) };
  const value: WorkspaceSnapshot = { ...sample(), sessions: [...sample().sessions, fixture] };
  await port.save(value, null); await database.close();
  const next = await openShellDatabase(sqlite, 'android'); const record = await next.bindWorkspace(registration()).port.load(); assert(record);
  assert.deepEqual(record.snapshot, value);
  const restored = restoreWorkspace(record.snapshot);
  assert.equal(restored.focusedId, 'first'); assert.equal(restored.overview, false); assert.deepEqual(restored.sessions.map(item => item.id), ['third', 'first', 'second', 'fixture']);
  assert(Object.isFrozen(record.snapshot)); assert(Object.isFrozen(record.snapshot.sessions)); assert(Object.isFrozen(record.snapshot.sessions[0]));
});

test('published workspace pins the exact signed event across durable restore and rejects absent or malformed pins', async t => {
  const exactEventId = hex(5);
  const pinned = descriptor('published', { eventId: exactEventId });
  const restored = restoreWorkspace(snapshot({ schema: 1, sessions: [pinned], lastActiveId: 'published' }));
  assert.equal(restored.sessions[0]!.eventId, exactEventId);
  for (const invalid of [
    (({ eventId: _eventId, ...rest }) => rest)(pinned),
    { ...pinned, eventId: 'not-an-event-id' },
    { ...pinned, eventId: 'AB'.repeat(32) },
  ]) {
    assert.throws(() => snapshot({ schema: 1, sessions: [invalid], lastActiveId: 'published' }), assertCode('INVALID_INPUT'));
  }
  assert.throws(() => restoreWorkspace({ schema: 1, sessions: [{ ...pinned, eventId: undefined }], lastActiveId: 'published' }));
});

test('a structurally valid published pin remains available after a process-style workspace reopen', async t => {
  const { sqlite, database } = await setup(t);
  const id = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';
  const pin = descriptor(id, { title: 'Restored Napplet', publisher: hex(6), appId: 'restored-napplet',
    version: hex(7), eventId: hex(8) });
  const port = database.bindWorkspace(registration()).port;
  await port.save({ schema: 1, sessions: [pin], lastActiveId: id }, null);
  await database.close();
  const reopened = await openShellDatabase(sqlite, 'android');
  const record = await reopened.bindWorkspace(registration()).port.load();
  assert(record);
  const restored = restoreWorkspace(record.snapshot);
  assert.doesNotThrow(() => assertWorkspaceAvailability(restored));
  assert.deepEqual(restored.sessions, [pin]);
});

test('saving snapshots clones inputs before they can mutate while queued', async t => {
  const { sqlite, database } = await setup(t), reached = deferred(), release = deferred(); let held = false;
  sqlite.onStep = async sql => { if (sql === 'BEGIN IMMEDIATE' && !held) { held = true; reached.resolve(); await release.promise; } };
  const pending = database.bindStorage(registration()).port.get('hold'); await reached.promise;
  const port = database.bindWorkspace(registration()).port;
  const input = { schema: 1 as const, sessions: [{ ...descriptor('one') }], lastActiveId: 'one' };
  const save = port.save(input, null); input.sessions[0]!.title = 'mutated'; input.sessions.push({ ...descriptor('new') }); input.lastActiveId = 'new';
  release.resolve(); await pending; const saved = await save;
  assert.equal(saved.snapshot.sessions.length, 1); assert.equal(saved.snapshot.sessions[0]!.title, 'one'); assert.equal(saved.snapshot.lastActiveId, 'one');
});

test('workspace CAS prevents queued stale saves and stale-save overwrite after reopen', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindWorkspace(registration()).port;
  await port.save(sample(), null);
  const results = await Promise.allSettled([port.save({ ...sample(), lastActiveId: 'second' }, 0), port.save({ ...sample(), lastActiveId: 'third' }, 0)]);
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') assertCode('CONFLICT')(results[1]!.reason);
  await database.close(); const reopened = await openShellDatabase(sqlite, 'android');
  const next = reopened.bindWorkspace(registration()).port; assert.equal((await next.load())?.snapshot.lastActiveId, 'second');
  await assert.rejects(next.save(sample(), 0), assertCode('CONFLICT'));
});

test('strict workspace codec rejects malformed ownership references, duplicate/sparse IDs, extra fields and accessors', () => {
  const cases: unknown[] = [null, [], { ...sample(), schema: 2 }, { ...sample(), secret: 'no extra data' },
    { ...sample(), lastActiveId: 'absent' }, { ...sample(), sessions: [descriptor('same'), descriptor('same')] },
    { ...sample(), sessions: Array(1) }, { ...sample(), sessions: Array(65).fill(descriptor('same')) },
    { ...sample(), sessions: [{ ...descriptor('one'), source: 'network' }] },
    { ...sample(), sessions: [{ ...descriptor('one'), id: 'bad/id' }] },
    { ...sample(), sessions: [{ ...descriptor('one'), title: '\ud800' }] },
    { ...sample(), sessions: [{ ...descriptor('one'), privateKey: 'must not be serialized' }] },
    { ...sample(), get lastActiveId() { throw new Error('getter must not execute'); } },
    Object.assign(Object.create({ foreign: true }), sample()),
  ];
  const symbolArray = [descriptor('one')]; Object.defineProperty(symbolArray, Symbol('extra'), { value: 'rejected' });
  const accessorArray = [descriptor('one')]; Object.defineProperty(accessorArray, '0', { get: () => { throw new Error('array getter must not run'); } });
  cases.push({ ...sample(), sessions: symbolArray }, { ...sample(), sessions: accessorArray });
  for (const value of cases) assert.throws(() => snapshot(value), assertCode('INVALID_INPUT'));
  assert.equal(utf8Bytes('aé值💫\u0000'), 11);
});

test('corrupt persisted workspace is an error; no silent empty replacement or erase', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindWorkspace(registration()).port;
  await port.save(sample(), null);
  sqlite.raw().prepare('UPDATE workspaces SET payload = ? WHERE user = ?').run('{"schema":1,"sessions":[],"lastActiveId":null,"extra":true}', hex(1));
  await assert.rejects(port.load(), assertCode('CORRUPT_STORAGE'));
  await assert.rejects(port.save(snapshotWorkspace(emptyWorkspace()), null), assertCode('CORRUPT_STORAGE'));
  assert.equal(sqlite.raw().prepare('SELECT count(*) AS n FROM workspaces').get()!['n'], 1);
});

test('schema mismatch and foreign-key corruption fail closed without replacing the database', async t => {
  const { sqlite, database } = await setup(t); await database.close();
  const raw = sqlite.raw(); raw.exec('PRAGMA user_version = 8');
  await assert.rejects(openShellDatabase(sqlite, 'ios'), assertCode('CORRUPT_STORAGE'));
  assert.equal(raw.prepare('PRAGMA user_version').get()!['user_version'], 8);
  raw.exec('PRAGMA user_version = 1'); raw.exec('CREATE TABLE unexpected (private TEXT)');
  await assert.rejects(openShellDatabase(sqlite, 'ios'), assertCode('CORRUPT_STORAGE'));
  assert(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'unexpected'").get());
});

test('workspace save failure rolls back its revision and selected focus', async t => {
  const { sqlite, database } = await setup(t); const port = database.bindWorkspace(registration()).port;
  await port.save(sample(), null); sqlite.faults.push({ prefix: 'UPDATE workspaces', mode: 'after' });
  await assert.rejects(port.save({ ...sample(), lastActiveId: 'second' }, 0), assertCode('STORAGE_FAILURE'));
  assert.deepEqual(await port.load(), { revision: 0, snapshot: sample() });
});

test('independent Node processes preserve strings and explicit-empty workspace using the fixed on-disk database', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { sqlite, database } = await setup(t); await database.close();
  const worker = fileURLToPath(new URL('./process-worker.ts', import.meta.url));
  const write = spawnSync(process.execPath, [worker, sqlite.directory, 'write'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(write.status, 0, write.stderr);
  const read = spawnSync(process.execPath, [worker, sqlite.directory, 'read'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { workspace: { revision: 0, snapshot: { schema: 1, sessions: [], lastActiveId: null } }, value: 'persisted across actual Node processes' });
});
