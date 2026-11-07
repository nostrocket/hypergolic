import assert from 'node:assert/strict';
import test from 'node:test';
import type { NostrEvent } from 'nostr-tools/pure';
import { captureEventSnapshot } from '../../src/security/event-snapshot.ts';
import { APP_DATA_PROFILE, APP_DATA_KIND, APP_DATA_MAX_CONTENT_BYTES, APP_DATA_READ_MAX_CONTENT_BYTES,
  AppDataError, deriveAppDataScope, dataIdentifier, dataTags, decodeAppDataRecord, captureAppDataTemplate,
  claimsAppDataTemplate, selectLatestAppDataEvent } from '../../src/app-data/app-data-contract.ts';

const author = 'a'.repeat(64), publisher = '3aa5817273c3b2f94f491840e0472f049d0f10009e23de63006166bca9b36ea3';
const scope = deriveAppDataScope({publisher, kind: 35129, identifier: 'n-b87c04571a9'});
const baseBody = () => ({schema: 'soyindent.level', version: 1, title: 'Owned level', previous: null as string | null, deleted: false, data: {rooms: 1}});
function template(body: unknown = baseBody(), tags: unknown = dataTags(scope, 'levels', 'owned', 'soyindent.level', 1)) {
  return {kind: APP_DATA_KIND, content: JSON.stringify(body), tags, created_at: 100};
}
function rejects(operation: () => unknown, code?: string) {
  assert.throws(operation, error => error instanceof AppDataError && (code === undefined || error.code === code));
}
function sized(bytes: number) {
  const body = {...baseBody(), data: ''};
  body.data = 'x'.repeat(bytes - new TextEncoder().encode(JSON.stringify(body)).length);
  const event = template(body);assert.equal(new TextEncoder().encode(event.content).length, bytes);return event;
}
// Selection is a pure step AFTER the existing verified-event pipeline; these inert fixtures do not prove signatures.
function event(id: string, time: number, content = template().content, key = author): NostrEvent {
  return {id: id.repeat(64), pubkey: key, kind: APP_DATA_KIND, created_at: time,
    content, tags: dataTags(scope, 'levels', 'owned', 'soyindent.level', 1).map(tag => [...tag]), sig: '0'.repeat(128)};
}

test('stable verified35129 coordinate matches exact Outbreak scope and separates publisher/identifier', () => {
  assert.equal(scope, 'a60a5107d883f838352fdab88a81d633d59625e7bde403e17406beddc3386243');
  assert.notEqual(scope, deriveAppDataScope({publisher: author, kind: 35129, identifier: 'n-b87c04571a9'}));
  assert.notEqual(scope, deriveAppDataScope({publisher, kind: 35129, identifier: 'different'}));
  for (const input of [{publisher, kind: 5129, identifier: 'n-b87c04571a9'}, {publisher, kind: 35129, identifier: ''},
    {publisher, kind: 35129, identifier: 'x', account: author}, {publisher: publisher.toUpperCase(), kind: 35129, identifier: 'x'}]) rejects(() => deriveAppDataScope(input));
});

test('exact six tags are immutable, reorderable and uniquely bound to body/namespace', () => {
  const tags = dataTags(scope, 'levels', 'owned', 'soyindent.level', 1);
  assert(Object.isFrozen(tags) && tags.every(Object.isFrozen));
  assert.equal(dataIdentifier(scope, 'levels', 'owned'), APP_DATA_PROFILE + ':' + scope + ':levels:owned');
  const record = decodeAppDataRecord(template(baseBody(), [...tags].reverse()));
  assert.equal(record.body.title, 'Owned level');assert(Object.isFrozen(record) && Object.isFrozen(record.body) && Object.isFrozen(record.body.data));
  const mutations = [tags.slice(1), [...tags, ['extra', 'x']], [tags[0], tags[0], ...tags.slice(2)],
    tags.map(tag => tag[0] === 's' ? ['s', author] : tag), tags.map(tag => tag[0] === 'l' ? ['l', 'other', APP_DATA_PROFILE] : tag),
    tags.map(tag => tag[0] === 'v' ? ['v', '01'] : tag), tags.map(tag => tag[0] === 'd' ? [...tag, 'extra'] : tag)];
  for (const changed of mutations) rejects(() => decodeAppDataRecord(template(baseBody(), changed)));
});

test('namespace/collection/id/schema/version and body shape reject malformed records', () => {
  for (const [s, c, id] of [[author.toUpperCase(), 'levels', 'x'], [scope, 'Levels', 'x'], [scope, 'levels', 'a:b']]) rejects(() => dataIdentifier(s!, c!, id!));
  for (const changes of [{schema: ''}, {version: 0}, {version: 1_000_001}, {title: ''}, {title: 'a\u202eb'}, {title: 'x'.repeat(161)}, {previous: 'x'}, {extra: true}]) {
    rejects(() => decodeAppDataRecord(template({...baseBody(), ...changes})));
  }
  rejects(() => decodeAppDataRecord({...template(), kind: 1}));
  rejects(() => decodeAppDataRecord({...template(), content: '{'}), 'app-data-invalid-json');
});

test('read16KiB and advertised/write3072B are separate exact UTF8 limits without envelope expansion', () => {
  assert.equal(APP_DATA_MAX_CONTENT_BYTES, 3072);assert.equal(APP_DATA_READ_MAX_CONTENT_BYTES, 16384);
  assert(decodeAppDataRecord(sized(16384)));rejects(() => decodeAppDataRecord(sized(16385)), 'app-data-too-large');
  assert(captureAppDataTemplate(sized(3072), author, scope));rejects(() => captureAppDataTemplate(sized(3073), author, scope), 'app-data-too-large');
  const multi = template({...baseBody(), data: '😀'.repeat(800)});
  assert(multi.content.length < 3072);rejects(() => captureAppDataTemplate(multi, author, scope), 'app-data-too-large');
});

test('normative parsedJSON4096 nodes and12 depth accept boundaries independently of routing2048', () => {
  const data = [Array(1024).fill(0), Array(1024).fill(0), Array(1024).fill(0), Array(1013).fill(0)];
  assert(decodeAppDataRecord(template({...baseBody(), data})));
  data[3]!.push(0);rejects(() => decodeAppDataRecord(template({...baseBody(), data})), 'app-data-too-complex');
  let nested: unknown = 0;for (let i = 0; i < 11; i++) nested = [nested];
  assert(decodeAppDataRecord(template({...baseBody(), data: nested})));
  rejects(() => decodeAppDataRecord(template({...baseBody(), data: [nested]})), 'app-data-too-complex');
  rejects(() => decodeAppDataRecord(template({...baseBody(), data: Array(1025).fill(0)})), 'app-data-too-complex');
});

test('JSON forbidden keys/object width reject while finite minuszero and escaped surrogate survive exact content', () => {
  rejects(() => decodeAppDataRecord(template({...baseBody(), data: Object.fromEntries(Array.from({length: 129}, (_, i) => ['k' + i, 0]))})));
  const bad = {...template(), content: template().content.replace('"rooms":1', '"__proto__":1')};rejects(() => decodeAppDataRecord(bad), 'app-data-invalid-json');
  const minus = {...template(), content: template().content.replace('{"rooms":1}', '-0')};assert(Object.is(decodeAppDataRecord(minus).body.data, -0));
  const escaped = template({...baseBody(), data: '\ud800'});assert(escaped.content.includes('\\ud800'));
  assert.equal(decodeAppDataRecord(escaped).body.data, '\ud800');assert.equal(captureAppDataTemplate(escaped, author, scope).content, escaped.content);
});

test('tombstones require previous revision and null data; live restore can reference a tombstone', () => {
  const tombstone = {...baseBody(), deleted: true, previous: 'b'.repeat(64), data: null};
  assert.equal(decodeAppDataRecord(template(tombstone)).body.deleted, true);
  rejects(() => decodeAppDataRecord(template({...tombstone, previous: null})));
  rejects(() => decodeAppDataRecord(template({...tombstone, data: {rooms: 1}})));
  assert(decodeAppDataRecord(template({...baseBody(), previous: 'c'.repeat(64)})));
});

test('descriptor-safe capture freezes exact canonical event without invoking getters or granting scope', () => {
  const input = template();const captured = captureAppDataTemplate(input, author, scope);
  assert.deepEqual(captured, input);assert(Object.isFrozen(captured) && Object.isFrozen(captured.tags));
  assert.equal(captureEventSnapshot(captured, author, ['wss://relay.damus.io']).hash.length, 64);
  input.content = '{}';assert.notEqual(captured.content, input.content);
  rejects(() => captureAppDataTemplate(template(), author, 'f'.repeat(64)), 'app-data-scope-mismatch');
  let calls = 0;const accessor = Object.defineProperty({...template()}, 'content', {get() {calls++;return '{}';}});
  rejects(() => captureAppDataTemplate(accessor, author, scope));rejects(() => decodeAppDataRecord(accessor));assert.equal(calls, 0);
  const sparse = [...dataTags(scope, 'levels', 'owned', 'soyindent.level', 1)];delete sparse[1];rejects(() => decodeAppDataRecord(template(baseBody(), sparse)));
});

test('claim classifier catches malformed soy markers without taking over unrelated NIP78', () => {
  assert.equal(claimsAppDataTemplate(template()), true);
  assert.equal(claimsAppDataTemplate({kind: 30078, tags: [['d', 'unrelated-private-setting']]}), false);
  for (const input of [{kind: 1, tags: [['d', APP_DATA_PROFILE + ':' + scope]]}, {kind: 30078, tags: [['L', APP_DATA_PROFILE]]},
    {tags: [['l', 'schema', APP_DATA_PROFILE]]}, {tags: [['d', APP_DATA_PROFILE]]}]) assert.equal(claimsAppDataTemplate(input), true);
  const removed = template(baseBody(), dataTags(scope, 'levels', 'owned', 'soyindent.level', 1).filter(tag => tag[0] !== 'L'));
  assert.equal(claimsAppDataTemplate(removed), true);rejects(() => decodeAppDataRecord(removed));
  let called = false;const accessor = Object.defineProperty({}, 'tags', {get() {called = true;return [];}});
  assert.equal(claimsAppDataTemplate(accessor), true);assert.equal(called, false);
});

test('newest exact coordinate chosen before decode, including invalid latest and ID tie-break; input not reordered', () => {
  const older = event('2', 10), invalid = event('3', 11, '{}');const rows = [older, invalid, event('0', 100, '{}', 'b'.repeat(64))];
  assert.equal(selectLatestAppDataEvent(rows, author, dataIdentifier(scope, 'levels', 'owned')), invalid);
  rejects(() => decodeAppDataRecord(invalid));assert.equal(rows[0], older);
  const low = event('0', 11);assert.equal(selectLatestAppDataEvent([invalid, low], author, dataIdentifier(scope, 'levels', 'owned')), low);
  assert.equal(selectLatestAppDataEvent(rows, author, dataIdentifier(scope, 'levels', 'other')), null);
});


test('foreign Proxy exceptions cannot interfere with closed inert error classification', () => {
  let inspected = 0;
  const thrown = new Proxy({}, {getPrototypeOf() {inspected++;throw new Error('Must not inspect foreign exception');}});
  const input = new Proxy({}, {getPrototypeOf() {throw thrown;}});
  rejects(() => decodeAppDataRecord(input), 'app-data-invalid-record');
  assert.equal(inspected, 0);
});
