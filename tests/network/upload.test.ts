import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventHash } from 'nostr-tools/pure';
import { parseUploadRequest, captureUploadBytes, captureBlobDescriptor, normalizeUploadServer,
  uploadInfo, uploadMime, UPLOAD_LIMITS, UploadError } from '../../src/uploads/upload-contract.ts';
import { captureUploadSnapshot } from '../../src/uploads/upload-snapshot.ts';

const fail = (code: string) => (value: unknown) => value instanceof UploadError && value.code === code;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pubkey = 'a'.repeat(64);
const body = () => new Uint8Array([1, 2, 3]);
const request = (overrides: object = {}) => ({type: 'upload.upload', id: 'u', request: {data: body().buffer, ...overrides}});
const snapshot = (bytes = body(), destination = 'https://files.example.com', identity = pubkey) =>
  captureUploadSnapshot(bytes, identity, destination, 'image/png', 1000, async value => hash(value));
const descriptor = (digest = hash(body())) => ({url: 'https://cdn.example.com/' + digest + '.png',
  sha256: digest, size: 3, type: 'image/png', uploaded: 1001});

test('selected draft wire accepts upload without info preflight and preserves all fields', () => {
  const parsed = parseUploadRequest(request({mimeType: 'IMAGE/PNG', filename: 'photo.png', caption: 'Alt text',
    noTransform: true, metadata: {license: 'CC0', dimensions: [1, 1]}}));
  assert.equal(parsed.type, 'upload.upload');
  if (parsed.type !== 'upload.upload') return;
  assert.equal(parsed.request.rail, 'blossom'); assert.equal(parsed.request.mimeType, 'image/png');
  assert.equal(parsed.request.filename, 'photo.png'); assert.equal(parsed.request.caption, 'Alt text');
  assert.equal(parsed.request.noTransform, true); assert.deepEqual(parsed.request.metadata?.dimensions, [1, 1]);
  assert.deepEqual(parseUploadRequest({type: 'upload.status', id: 's', uploadId: 'owned'}),
    {type: 'upload.status', id: 's', uploadId: 'owned'});
  assert.equal(uploadInfo().rails.find(value => value.rail === 'nip96')?.enabled, false);
  assert.equal(uploadInfo().maxBytes, UPLOAD_LIMITS.fileBytes);
});

test('strict wire rejects forged authority, legacy binary carriers and unimplemented methods', () => {
  for (const value of [{...request(), token: 'forged'}, {...request(), caller: 'other'},
    request({server: 'https://other.example.com'}), request({headers: {Authorization: 'secret'}}),
    request({data: 'AQID'}), request({data: body()}), request({data: new SharedArrayBuffer(3)}),
    request({noTransform: 'true'}), {type: 'upload.cancel', id: 'u'},
    {type: 'upload.status', id: 's', uploadId: ''}, {type: 'upload.info', id: 'i', extra: true}]) {
    assert.throws(() => parseUploadRequest(value), fail('invalid request'));
  }
  assert.throws(() => parseUploadRequest(request({rail: 'nip96'})), fail('unsupported rail'));
});

test('accessor, symbol and hidden fields are rejected without executing guest code', () => {
  let called = 0;
  const accessor = {type: 'upload.upload', id: 'u', get request() {called++; return {data: body().buffer};}};
  const payloadAccessor = request(); Object.defineProperty(payloadAccessor.request, 'mimeType', {enumerable: true, get() {called++; return 'image/png';}});
  const hidden = request(); Object.defineProperty(hidden, 'authority', {value: 'foreign'});
  const symbolic = request(); Object.defineProperty(symbolic, Symbol('authority'), {value: 'foreign', enumerable: true});
  for (const value of [accessor, payloadAccessor, hidden, symbolic, Object.assign(Object.create(null), request())]) {
    assert.throws(() => parseUploadRequest(value), fail('invalid request'));
  }
  assert.equal(called, 0);
});

test('text limits count UTF-8 and reject ill-formed Unicode', () => {
  for (const value of [request({filename: 'é'.repeat(129)}), request({caption: '\ud800'}),
    {...request(), id: '😀'.repeat(33)}, request({metadata: {'\ud800': 'bad'}})]) {
    assert.throws(() => parseUploadRequest(value), fail('invalid request'));
  }
  assert.throws(() => uploadMime('image/png; charset=utf-8'), fail('unsupported media type'));
  assert.throws(() => uploadMime('image/png\r\nAuthorization: forged'), fail('unsupported media type'));
});

test('metadata is deeply captured and prototype-like keys remain inert JSON', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"nested":{"list":["original"]}}');
  const parsed = parseUploadRequest(request({metadata: input}));
  if (parsed.type !== 'upload.upload') throw Error('wrong type');
  input.nested.list[0] = 'changed';
  const copied = parsed.request.metadata!;
  assert.equal(Object.getPrototypeOf(copied), null); assert.equal(Object.isFrozen(copied), true);
  assert.equal(Object.isFrozen(copied.nested), true);
  assert.deepEqual((copied.nested as Record<string, unknown>).list, ['original']);
  assert.deepEqual(copied.__proto__, Object.assign(Object.create(null), {polluted: true}));
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('metadata rejects accessor arrays, sparse arrays, cycles, non-JSON and excessive depth/bytes', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const array = [1]; Object.defineProperty(array, '0', {enumerable: true, get() {throw Error('guest getter executed');}});
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 10; i++) deep = {child: deep};
  for (const value of [{bad: undefined}, {bad: Infinity}, {bad: new Date()}, {bad: new Array(1)},
    {bad: array}, cycle, deep, {big: 'a'.repeat(UPLOAD_LIMITS.metadataBytes)}, {many: Array(256).fill(1)}]) {
    assert.throws(() => parseUploadRequest(request({metadata: value})), fail('invalid request'));
  }
});

test('server configuration captures one public HTTPS origin without extra authority', () => {
  assert.equal(normalizeUploadServer('https://FILES.example.com:443/'), 'https://files.example.com');
  assert.equal(normalizeUploadServer('https://files.example.com:8443'), 'https://files.example.com:8443');
  for (const value of ['https://files.example.com/upload', 'https://files.example.com?fallback=x',
    'https://files.example.com#hidden', 'https://user:secret@files.example.com', 'http://files.example.com',
    'https://127.0.0.1', 'https://2130706433', 'https://local.home.arpa', 'https://files.example.com/\n']) {
    assert.throws(() => normalizeUploadServer(value), fail('policy denied'));
  }
});

test('mutable ArrayBuffer is copied synchronously before caller mutation or detachment', async () => {
  const input = body(); const captured = captureUploadBytes(input.buffer);
  input[0] = 99; structuredClone(input.buffer, {transfer: [input.buffer]});
  assert.deepEqual(await captured, body());
  await assert.rejects(captureUploadBytes(input.buffer), fail('invalid request'));
});

test('capture bypasses overridden binary methods and species', async () => {
  class HostileBuffer extends ArrayBuffer {
    static get [Symbol.species](): ArrayBufferConstructor {throw Error('species executed');}
    slice(): ArrayBuffer {throw Error('slice executed');}
  }
  const buffer = new HostileBuffer(3); new Uint8Array(buffer).set(body());
  assert.deepEqual(await captureUploadBytes(buffer), body());
  class HostileBlob extends Blob {arrayBuffer(): Promise<ArrayBuffer> {throw Error('method executed');}}
  assert.deepEqual(await captureUploadBytes(new HostileBlob([body()])), body());
});

test('binary capture bounds actual intrinsic sizes including empty and oversized blobs', async () => {
  assert.equal((await captureUploadBytes(new ArrayBuffer(0))).byteLength, 0);
  for (const input of [new ArrayBuffer(UPLOAD_LIMITS.fileBytes + 1), new Blob([new Uint8Array(UPLOAD_LIMITS.fileBytes + 1)])]) {
    await assert.rejects(captureUploadBytes(input), fail('file too large'));
  }
});

test('snapshot owns reviewed bytes before async hash and isolates hashing/review copies', async () => {
  const input = body(); let finish!: () => void;
  const waiting = new Promise<void>(resolve => {finish = resolve;});
  const captured = captureUploadSnapshot(input, pubkey, 'https://files.example.com', 'image/png', 1000, async bytes => {
    const digest = hash(bytes); bytes.fill(99); await waiting; return digest;
  });
  input.fill(77); finish(); const result = await captured;
  assert.equal(result.sha256, hash(body())); assert.deepEqual(result.copyBytes(), body());
  result.copyBytes().fill(88); assert.deepEqual(result.copyBytes(), body());
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.authorization.tags[0]), true);
});

test('authorization is short-lived, server/hash scoped and bound to the selected identity', async () => {
  const value = await snapshot();
  assert.equal(value.purpose, 'blossom-upload'); assert.equal(value.authorization.kind, 24242);
  assert.deepEqual(value.authorization.tags, [['t', 'upload'], ['x', hash(body())],
    ['server', 'files.example.com'], ['expiration', '1120']]);
  assert.equal(value.eventHash, getEventHash({...value.authorization, pubkey, tags: value.authorization.tags.map(tag => [...tag])}));
  assert.notEqual(value.eventHash, (await snapshot(body(), 'https://other.example.com')).eventHash);
  assert.notEqual(value.eventHash, (await snapshot(body(), 'https://files.example.com', 'b'.repeat(64))).eventHash);
  assert.notEqual(value.eventHash, (await snapshot(new Uint8Array([1, 2, 4]))).eventHash);
  assert.notEqual(value.eventHash, (await snapshot(body(), 'https://files.example.com:8443')).eventHash);
});

test('snapshot rejects invalid identity, hash, destination and time rather than broadening scope', async () => {
  await assert.rejects(snapshot(body(), 'https://localhost', pubkey), fail('policy denied'));
  await assert.rejects(snapshot(body(), 'https://files.example.com', 'not-a-key'), fail('invalid request'));
  for (const time of [0, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(captureUploadSnapshot(body(), pubkey, 'https://files.example.com', 'image/png', time, async bytes => hash(bytes)), fail('invalid request'));
  }
  await assert.rejects(captureUploadSnapshot(body(), pubkey, 'https://files.example.com', 'image/png', 1000, async () => 'f'.repeat(63)), fail('invalid request'));
});

test('provider receipt is captured only for the approved hash, size and public download URL', () => {
  const value = {...descriptor(), magnet: 'magnet:?xt=bounded', extra: {labels: ['original']}};
  const captured = captureBlobDescriptor(value, hash(body()), 3);
  value.extra.labels[0] = 'changed'; assert.deepEqual((captured.extra as Record<string, unknown>).labels, ['original']);
  assert.equal(captured.magnet, 'magnet:?xt=bounded');
  value.url = 'https://evil.example.com/changed'; assert.equal(captured.sha256, hash(body()));
  assert.equal(captured.url, descriptor().url); assert.equal(Object.isFrozen(captured), true);
  for (const changed of [{sha256: 'b'.repeat(64)}, {size: 4}, {uploaded: -1}, {uploaded: 1.5},
    {url: 'https://127.0.0.1/' + hash(body()) + '.png'}, {url: descriptor().url + '?token=secret'},
    {url: 'https://cdn.example.com/not-the-hash.png'}, {type: 'image/png; charset=x'}]) {
    assert.throws(() => captureBlobDescriptor({...descriptor(), ...changed}, hash(body()), 3), fail('upload failed'));
  }
  const getter = descriptor(); Object.defineProperty(getter, 'url', {enumerable: true, get() {throw Error('getter executed');}});
  assert.throws(() => captureBlobDescriptor(getter, hash(body()), 3), fail('upload failed'));
});

 test('captured metadata survives native-port to review recapture without relaxing object authority', () => {
  const original = parseUploadRequest(request({metadata: JSON.parse('{"__proto__":{"inert":true},"nested":{"list":["é","😀"]}}')}));
  if (original.type !== 'upload.upload') throw Error('wrong type');
  const repeated = parseUploadRequest({type: 'upload.upload', id: 'review', request: original.request});
  if (repeated.type !== 'upload.upload') throw Error('wrong type');
  assert.deepEqual(repeated.request.metadata, original.request.metadata);
  assert.notEqual(repeated.request.metadata, original.request.metadata);
  assert.equal(Object.getPrototypeOf(repeated.request.metadata), null);
  assert.throws(() => parseUploadRequest(Object.assign(Object.create(null), original)), fail('invalid request'));
  assert.throws(() => parseUploadRequest(request({metadata: Object.create({inherited: 'authority'})})), fail('invalid request'));
});
