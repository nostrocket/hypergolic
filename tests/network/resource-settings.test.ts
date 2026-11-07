import test from 'node:test';
import assert from 'node:assert/strict';
import { openResourceSettings, normalizeResourceServers, DEFAULT_RESOURCE_SERVERS, RESOURCE_SETTINGS_KEY } from '../../src/resources/resource-settings.ts';
test('trusted download settings seed defaults once and persist edits, disable and restore',async()=>{
  const rows = new Map<string,string>();
  const storage={getItem:async(key:string)=>rows.get(key)??null,setItem:async(key:string,value:string)=>{rows.set(key,value);}};
  const first=await openResourceSettings(storage);assert.deepEqual(first.servers(),DEFAULT_RESOURCE_SERVERS);
  await first.replace(['https://downloads.public.org']);const reopened=await openResourceSettings(storage);assert.deepEqual(reopened.servers(),['https://downloads.public.org']);
  await reopened.replace([]);assert.deepEqual((await openResourceSettings(storage)).servers(),[]);
  await reopened.restoreDefaults();assert.deepEqual(reopened.servers(),DEFAULT_RESOURCE_SERVERS);
});
test('settings reject hinted paths, private literals, credentials, duplicates and excessive lists',()=>{
  for(const value of [['https://127.0.0.1'],['https://host.local'],['https://user@downloads.public.org'],['https://downloads.public.org/path'],['https://downloads.public.org?xs=https://private.local'],Array(5).fill('https://downloads.public.org'),['https://downloads.public.org','https://downloads.public.org/']])assert.throws(()=>normalizeResourceServers(value));
});
test('failed settings writes retain the last confirmed snapshot and do not poison future edits',async()=>{
  let stored:string|null=null,fail=false;
  const settings=await openResourceSettings({getItem:async()=>stored,setItem:async(_,value)=>{if(fail)throw Error('storage');stored=value;}});
  fail=true;await assert.rejects(settings.replace([]));assert.deepEqual(settings.servers(),DEFAULT_RESOURCE_SERVERS);
  fail=false;await settings.replace([]);assert.deepEqual(settings.servers(),[]);
});

const expectedDefaults = ['https://blossom.primal.net', 'https://cdn.satellite.earth', 'https://blssm.us'];
test('fresh download settings seed three ordered mirrors only once', async () => {
  let stored: string | null = null;
  const writes: string[] = [];
  const storage = {getItem: async () => stored, setItem: async (_key: string, value: string) => {
    writes.push(value); stored = value;
  }};
  assert.deepEqual((await openResourceSettings(storage)).servers(), expectedDefaults);
  assert.deepEqual((await openResourceSettings(storage)).servers(), expectedDefaults);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!), {schema: 1, servers: expectedDefaults});
});

test('every saved schema1 list survives unchanged until explicit Restore defaults', async () => {
  for (const saved of [expectedDefaults.slice(0, 2), [], ['https://downloads.public.org'], [...expectedDefaults].reverse()]) {
    let stored = JSON.stringify({schema: 1, servers: saved});
    const original = stored, writes: string[] = [];
    const storage = {getItem: async (key: string) => {
      assert.equal(key, RESOURCE_SETTINGS_KEY); return stored;
    }, setItem: async (key: string, value: string) => {
      assert.equal(key, RESOURCE_SETTINGS_KEY); writes.push(value); stored = value;
    }};
    const settings = await openResourceSettings(storage);
    assert.deepEqual(settings.servers(), saved);
    assert.equal(stored, original);
    assert.equal(writes.length, 0);
    await settings.restoreDefaults();
    assert.deepEqual(settings.servers(), expectedDefaults);
    assert.deepEqual(JSON.parse(stored), {schema: 1, servers: expectedDefaults});
    assert.deepEqual((await openResourceSettings(storage)).servers(), expectedDefaults);
    assert.equal(writes.length, 1);
  }
});
