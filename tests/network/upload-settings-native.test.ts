import test from 'node:test';
import assert from 'node:assert/strict';
import {openNativeUploadSettings} from '../../src/uploads/upload-settings-native.ts';
import {DEFAULT_UPLOAD_SERVER} from '../../src/uploads/upload-settings.ts';
import type {SQLiteConnection, SQLiteModule, SQLiteValue} from '../../src/storage/sqlite.ts';
function fixture(saved: string | null = null) {
  const calls: string[] = [], configured: (string | null)[] = [];
  let failWrite = false, failNative = false;
  const db: SQLiteConnection = {execAsync: async sql => {calls.push(sql);},
    getAllAsync: async <T>(sql: string) => {calls.push(sql); return (saved === null ? [] : [{payload: saved}]) as T[];},
    runAsync: async (sql: string, ...params: SQLiteValue[]) => {calls.push(sql); if (failWrite) throw Error('disk failure'); saved = params[1] as string; return {changes: 1};},
    isInTransactionAsync: async () => false, closeAsync: async () => {calls.push('close');}};
  const sqlite: SQLiteModule = {openDatabaseAsync: async (name, options) => {assert.equal(name, 'hypergolic-upload-settings-v1.db'); assert.deepEqual(options, {useNewConnection: true, enableChangeListener: false}); return db;}};
  const native = {configureUploadServer(server: string | null) {configured.push(server); if (failNative && server !== null) throw Error('native failure');}};
  return {calls, configured, sqlite, native, failWrite(value: boolean) {failWrite = value;}, failNative(value: boolean) {failNative = value;}, saved: () => saved};
}
test('private settings store persists before native activation and serializes destination changes', async () => {
  const f = fixture(), service = await openNativeUploadSettings(f.sqlite, f.native);
  assert.deepEqual(f.configured, [null, DEFAULT_UPLOAD_SERVER]);
  await Promise.all([service.replace('https://one.example.org'), service.replace('https://two.example.org')]);
  assert.equal(service.server(), 'https://two.example.org'); assert.equal(JSON.parse(f.saved()!).server, service.server());
  assert.deepEqual(f.configured.slice(-2), ['https://one.example.org', 'https://two.example.org']);
  await service.close(); assert.equal(service.server(), null); assert.equal(f.calls.at(-1), 'close');
  await assert.rejects(service.restoreDefault());
});
test('failed persistence keeps the previous native destination, while native failure disables admission', async () => {
  const f = fixture(), service = await openNativeUploadSettings(f.sqlite, f.native);
  f.failWrite(true); await assert.rejects(service.replace('https://one.example.org'));
  assert.equal(service.server(), DEFAULT_UPLOAD_SERVER); assert.equal(f.configured.at(-1), DEFAULT_UPLOAD_SERVER);
  f.failWrite(false); f.failNative(true); await assert.rejects(service.replace('https://one.example.org'));
  assert.equal(service.server(), null); assert.equal(f.configured.at(-1), null);
  f.failNative(false); await service.restoreDefault(); assert.equal(service.server(), DEFAULT_UPLOAD_SERVER);
});
test('corrupt saved configuration leaves upload admission disabled and closes its database', async () => {
  const f = fixture('{"schema":1,"server":"https://localhost"}');
  await assert.rejects(openNativeUploadSettings(f.sqlite, f.native));
  assert.equal(f.configured.at(-1), null); assert.equal(f.calls.at(-1), 'close');
});
