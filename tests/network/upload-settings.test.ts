import test from 'node:test';
import assert from 'node:assert/strict';
import { openUploadSettings, DEFAULT_UPLOAD_SERVER, UPLOAD_SETTINGS_KEY } from '../../src/uploads/upload-settings.ts';
import { UploadError } from '../../src/uploads/upload-contract.ts';

function storage(saved: string | null = null) {
  const writes: string[] = [];
  return {writes, port: {getItem: async (key: string) => {assert.equal(key, UPLOAD_SETTINGS_KEY); return saved;},
    setItem: async (key: string, value: string) => {assert.equal(key, UPLOAD_SETTINGS_KEY); writes.push(value);}}};
}
test('first run persists exactly one independent upload default; disabling persists across reopen', async () => {
  const value = storage(); const settings = await openUploadSettings(value.port);
  assert.equal(settings.server(), DEFAULT_UPLOAD_SERVER);
  await settings.replace(null); assert.equal(settings.server(), null);
  assert.equal((await openUploadSettings(storage(value.writes[1]).port)).server(), null);
  await settings.restoreDefault(); assert.equal(settings.server(), DEFAULT_UPLOAD_SERVER);
});
test('configuration rejects fallback lists, extra authority and invalid persisted values', async () => {
  for (const value of ['broken', 'null', '[]', '{"schema":2,"server":null}',
    '{"schema":1,"server":["https://one.example.com"]}',
    '{"schema":1,"server":"https://files.example.com/upload"}',
    '{"schema":1,"server":null,"fallback":"https://other.example.com"}']) {
    await assert.rejects(openUploadSettings(storage(value).port), value => value instanceof UploadError && value.code === 'policy denied');
  }
});
test('failed writes retain current destination and do not poison the next explicit write', async () => {
  let calls = 0;
  const settings = await openUploadSettings({getItem: async () => '{"schema":1,"server":"https://one.example.com"}',
    setItem: async () => {if (++calls === 1) throw Error('disk failure');}});
  await assert.rejects(settings.replace('https://two.example.com'));
  assert.equal(settings.server(), 'https://one.example.com');
  await settings.replace('https://three.example.com'); assert.equal(settings.server(), 'https://three.example.com');
});
test('serialized updates capture canonical destinations before asynchronous persistence', async () => {
  const value = storage('{"schema":1,"server":null}'); const settings = await openUploadSettings(value.port);
  await Promise.all([settings.replace('https://ONE.example.com:443/'), settings.replace('https://two.example.com')]);
  assert.equal(settings.server(), 'https://two.example.com');
  assert.deepEqual(value.writes.map(raw => JSON.parse(raw).server), ['https://one.example.com', 'https://two.example.com']);
});
