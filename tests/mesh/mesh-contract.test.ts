import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {parseRelaySubscribe} from '../../src/network/relay-subscription-contract.ts';
import {parseMeshRequest, captureMeshResult, captureMeshDelivery, meshFailure, MeshContractError,
  MESH_DEFAULT_CAPS, MESH_LIMITS, type MeshPublishRequest, type MeshSubscribeRequest} from '../../src/mesh/mesh-contract.ts';

const key = new Uint8Array(32).fill(1), author = getPublicKey(key);
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const publish = (event: unknown = {kind: 1, content: 'hello'}, ttl?: unknown): MeshPublishRequest =>
  parseMeshRequest({type: 'mesh.publish', id: 'p1', event, ...(ttl === undefined ? {} : {ttl})}) as MeshPublishRequest;
const subscription = (filters: unknown = [{kinds: [20431]}], ttl?: unknown): MeshSubscribeRequest =>
  parseMeshRequest({type: 'mesh.subscribe', id: 's1', subId: 'room', filters, ...(ttl === undefined ? {} : {ttl})}) as MeshSubscribeRequest;
const event = (kind = 1, content = 'hello', tags: string[][] = [], created_at = 1234) =>
  wire(finalizeEvent({kind, content, tags, created_at}, key));
const success = (request: MeshPublishRequest, signed = event(request.event.kind, request.event.content, request.event.tags.map(tag => [...tag]))) =>
  ({type: 'mesh.publish.result', id: request.id, ok: true, event: signed, eventId: signed.id, ttl: request.ttl});
const invalid = (run: () => unknown) => assert.throws(run, MeshContractError);

// Exact original WoTformer sends kind20431/templates with its own timestamp, both publish options and ttl0 subscribe.
test('original WoTformer message shape captures provenance without trusting author or timestamp', () => {
  const tags = [['t', 'wotformer'], ['expiration', '1790000060']], content = JSON.stringify({v: 1, sid: 'owned-test', t: 'disp'});
  const request = publish({kind: 20431, content, tags, created_at: 1790000000}, 2);
  assert.deepEqual(request, {type: 'mesh.publish', id: 'p1', event: {kind: 20431, content, tags, created_at: 1790000000}, ttl: 2});
  const signed = event(20431, content, tags, 1790000100);
  const reply = captureMeshResult(success(request, signed), request, author);
  assert.equal(reply.type, 'mesh.publish.result');
  if ('event' in reply) assert.equal(reply.event.created_at, 1790000100);
  assert.equal(subscription([{kinds: [20431], '#t': ['wotformer'], since: 1789999400}], 0).ttl, 0);
  for (const name of ['pubkey', 'id', 'sig']) invalid(() => publish({kind: 20431, content, tags, [name]: '0'.repeat(name === 'sig' ? 128 : 64)}));
});

test('full template profile accepts non-ephemeral kinds and normative omitted tags', () => {
  for (const kind of [0, 1, 20431, 30078, 65535]) {
    const request = publish({kind, content: ''});
    assert.deepEqual(request.event.tags, []); assert(!Object.hasOwn(request.event, 'created_at'));
  }
  for (const value of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1234']) invalid(() => publish({kind: 1, content: '', created_at: value}));
  for (const kind of [-1, 1.5, 65536, '1']) invalid(() => publish({kind, content: ''}));
  invalid(() => publish({kind: 1})); invalid(() => publish({kind: 1, content: '', extra: true}));
});

test('hop budgets default, clamp above selected caps and reject malformed requests whole', () => {
  assert.deepEqual(MESH_DEFAULT_CAPS, {publishTtl: 2, subscribeTtl: 1}); assert.equal(MESH_LIMITS.incomingTtl, 2);
  assert.equal(publish().ttl, 2); assert.equal(subscription().ttl, 1);
  assert.equal(publish(undefined, 255).ttl, 2); assert.equal(subscription(undefined, 255).ttl, 1);
  assert.equal(publish(undefined, 0).ttl, 0); assert.equal(subscription(undefined, 0).ttl, 0);
  const caps = {publishTtl: 0, subscribeTtl: 3};
  assert.equal((parseMeshRequest({type: 'mesh.publish', id: 'p', event: {kind: 1, content: ''}}, caps) as MeshPublishRequest).ttl, 0);
  assert.equal((parseMeshRequest({type: 'mesh.subscribe', id: 's', subId: 'x', filters: {}}, caps) as MeshSubscribeRequest).ttl, 3);
  for (const ttl of [-1, 256, 0.5, '1', null, true, NaN, Infinity]) {
    invalid(() => publish(undefined, ttl)); invalid(() => subscription(undefined, ttl));
  }
  invalid(() => parseMeshRequest({type: 'mesh.publish', id: 'p', event: {kind: 1, content: ''}}, {publishTtl: 256, subscribeTtl: 1}));
});

test('NIP01 filters support object/list input and preserve exact lists without slicing fifth filter', () => {
  const request = subscription({kinds: [1], authors: [author], '#t': ['a'], since: 10, until: 20, limit: 2});
  assert.deepEqual(request.filters, [{kinds: [1], authors: [author], '#t': ['a'], since: 10, until: 20, limit: 2}]);
  assert.equal(subscription([{}, {}, {}, {}]).filters.length, 4);
  for (const filters of [[], [{}, {}, {}, {}, {}], [{authors: ['bad']}], [{kinds: [65536]}], [{since: 2, until: 1}], [{search: 'music'}], [{limit: -1}], [{'#t': []}], [{kinds: Array(65).fill(1)}]]) invalid(() => subscription(filters));
  assert.equal(subscription([{limit: 100}]).filters[0]?.limit, 32); // Existing bounded NIP01 backlog policy, not array truncation.
});

test('Mesh close is fire-and-forget and its subscription namespace does not borrow Relay IDs', () => {
  assert.deepEqual(parseMeshRequest({type: 'mesh.close', subId: 'same'}), {type: 'mesh.close', subId: 'same'});
  const mesh = parseMeshRequest({type: 'mesh.subscribe', id: 'r', subId: 'same', filters: [{}]});
  const relay = parseRelaySubscribe({type: 'relay.subscribe', id: 'r', subId: 'same', filters: [{}]});
  assert.equal(mesh.type, 'mesh.subscribe'); assert.equal(relay.type, 'relay.subscribe');
  invalid(() => parseMeshRequest({type: 'mesh.close', id: 'invented', subId: 'same'}));
  invalid(() => parseMeshRequest({type: 'mesh.close'}));
  assert.equal(meshFailure({type: 'mesh.close', subId: 'same'}, 'denied'), null);
  assert.equal(meshFailure({type: 'mesh.close', id: 'invented', subId: 'same'}, 'denied'), null);
});

test('blob arrays normalize and deduplicate hashes, but reject oversized input before dedup', () => {
  const a = 'AB'.repeat(32), b = '12'.repeat(32);
  const request = parseMeshRequest({type: 'mesh.blobs', id: 'b', hashes: [a, a.toLowerCase(), b]});
  assert.deepEqual(request, {type: 'mesh.blobs', id: 'b', hashes: [a.toLowerCase(), b]});
  const empty = parseMeshRequest({type: 'mesh.blobs', id: 'empty', hashes: []});
  assert.deepEqual(captureMeshResult({type: 'mesh.blobs.result', id: 'empty', peers: 0, blobs: {}}, empty), {type: 'mesh.blobs.result', id: 'empty', peers: 0, blobs: {}});
  assert.equal((parseMeshRequest({type: 'mesh.blobs', id: '64', hashes: Array(64).fill(a)}) as {hashes: readonly string[]}).hashes.length, 1);
  for (const hashes of [Array(65).fill(a), [a, 'bad'], [a + ' '], [1], null, undefined]) invalid(() => parseMeshRequest({type: 'mesh.blobs', id: 'b', hashes}));
});

test('every request refusal preserves only a valid own correlation, never fabricated data', () => {
  for (const type of ['mesh.info', 'mesh.publish', 'mesh.subscribe', 'mesh.blobs']) {
    const input = {type, id: 'caller-id', ttl: -1, event: null, filters: null};
    assert.deepEqual(meshFailure(input, 'not granted'), {type: `${type}.result`, id: 'caller-id', ...(type === 'mesh.publish' ? {ok: false} : {}), error: 'not granted'});
  }
  for (const id of ['', 1, 'x\n', 'x'.repeat(129), '\ud800']) assert.equal(meshFailure({type: 'mesh.publish', id}, 'bad'), null);
  assert.equal(meshFailure({type: 'unknown', id: 'x'}, 'bad'), null);
  assert.equal(meshFailure({type: 'mesh.info', id: 'x'}, ''), null);
  const request = publish(); const failure = meshFailure(request, 'signing denied');
  assert.deepEqual(captureMeshResult(failure, request), failure);
  for (const extra of [{event: event()}, {eventId: '0'.repeat(64)}, {ttl: 0}, {ok: true}]) invalid(() => captureMeshResult({...failure, ...extra}, request));
});

test('native result ID/type and exact shapes are checked for every one-shot method', () => {
  const info = parseMeshRequest({type: 'mesh.info', id: 'i'});
  const result = {type: 'mesh.info.result', id: 'i', online: false, peers: 0, limits: {publishTtl: 2, subscribeTtl: 1}};
  assert.deepEqual(captureMeshResult(result, info), result);
  for (const delta of [{id: 'other'}, {type: 'relay.info.result'}, {peers: -1}, {online: true, peers: 1.5}, {online: false, peers: 1}, {limits: {publishTtl: 256, subscribeTtl: 1}}, {address: 'peer identity'}]) invalid(() => captureMeshResult({...result, ...delta}, info));
  assert.deepEqual(captureMeshResult({type: 'mesh.info.result', id: 'i', error: 'unavailable'}, info), {type: 'mesh.info.result', id: 'i', error: 'unavailable'});
  invalid(() => captureMeshResult({type: 'mesh.info.result', id: 'i', error: 'unavailable', peers: 0}, info));
  invalid(() => captureMeshResult({type: 'mesh.info.result', id: 'i', error: 'unavailable'}, {...info}));
  invalid(() => captureMeshResult({type: 'mesh.closed', subId: 'x'}, parseMeshRequest({type: 'mesh.close', subId: 'x'})));
});

test('blob responses contain every unique asked hash exactly once, with member counts bounded by peers', () => {
  const a = 'ab'.repeat(32), b = 'cd'.repeat(32), req = parseMeshRequest({type: 'mesh.blobs', id: 'b', hashes: [a, b]});
  const result = {type: 'mesh.blobs.result', id: 'b', peers: 2, blobs: {[a]: 0, [b]: 2}};
  assert.deepEqual(captureMeshResult(result, req), result);
  for (const delta of [{id: 'other'}, {peers: 1}, {blobs: {[a]: 0}}, {blobs: {[a]: 0, [b]: 3}}, {blobs: {[a]: 0, [b]: -1}}, {blobs: {[a.toUpperCase()]: 0, [b]: 0}}, {blobs: {[a]: 0, [b]: 0, ['ef'.repeat(32)]: 1}}]) invalid(() => captureMeshResult({...result, ...delta}, req));
});

test('native signed publish results authenticate fields while native timestamp supersedes provenance', () => {
  const req = publish({kind: 1, content: 'hello', tags: [['t', 'mesh']], created_at: 100});
  const signed = event(1, 'hello', [['t', 'mesh']], 999), result = success(req, signed);
  assert.deepEqual(captureMeshResult(result, req, author), result);
  for (const delta of [{id: 'other'}, {ttl: 0}, {eventId: '0'.repeat(64)}, {ok: false}, {extra: 1}, {event: {...signed, sig: '0'.repeat(128)}}, {event: {...signed, id: '0'.repeat(64)}}, {event: event(1, 'changed', [['t', 'mesh']])}, {event: event(2, 'hello', [['t', 'mesh']])}, {event: event(1, 'hello', [['t', 'changed']])}]) invalid(() => captureMeshResult({...result, ...delta}, req, author));
  invalid(() => captureMeshResult(result, req));
  invalid(() => captureMeshResult(result, req, '0'.repeat(64)));
});

test('subscription refusal is correlated by id; opened streams use only the exact subId', () => {
  const req = subscription();
  assert.deepEqual(captureMeshResult({type: 'mesh.subscribe.result', id: req.id, error: 'not granted'}, req), {type: 'mesh.subscribe.result', id: req.id, error: 'not granted'});
  invalid(() => captureMeshResult({type: 'mesh.subscribe.result', id: req.id, ok: true}, req));
  invalid(() => captureMeshResult({type: 'mesh.closed', subId: req.subId, reason: 'ended'}, req));
  assert.deepEqual(captureMeshDelivery({type: 'mesh.closed', subId: req.subId, reason: 'ended'}, req), {type: 'mesh.closed', subId: req.subId, reason: 'ended'});
  assert.deepEqual(captureMeshDelivery({type: 'mesh.eose', subId: req.subId, ttl: 1}, req), {type: 'mesh.eose', subId: req.subId, ttl: 1});
  for (const input of [{type: 'mesh.eose', subId: 'foreign', ttl: 1}, {type: 'mesh.eose', subId: req.subId, ttl: 2}, {type: 'mesh.eose', subId: req.subId, ttl: 1, id: req.id}, {type: 'mesh.closed', subId: req.subId, reason: 1}]) invalid(() => captureMeshDelivery(input, req));
});

test('stream events verify signature/hash/filter, allow later live events despite zero backlog limit', () => {
  const req = subscription([{kinds: [20431], '#t': ['wotformer'], limit: 0}], 0);
  const signed = event(20431, '{"x":1}', [['t', 'wotformer']]);
  const input = {type: 'mesh.event', subId: req.subId, result: {event: signed}};
  const captured = captureMeshDelivery(input, req);
  assert.deepEqual(captured, input);
  invalid(() => captureMeshDelivery(input, req, 'stored'));
  invalid(() => captureMeshDelivery({...input, subId: 'relay-only'}, req));
  invalid(() => captureMeshDelivery({...input, result: {event: {...signed, sig: '0'.repeat(128)}}}, req));
  invalid(() => captureMeshDelivery({...input, result: {event: event(20431, '', [['t', 'other']])}}, req));
  assert(Object.isFrozen(captured)); if ('result' in captured) assert(Object.isFrozen(captured.result.event.tags[0]));
});

test('capture is detached and deeply immutable across caller mutation and duplicate deliveries', () => {
  const input = {type: 'mesh.publish', id: 'p', event: {kind: 1, content: 'hello', tags: [['t', 'before']], created_at: 12}, ttl: 2};
  const req = parseMeshRequest(input) as MeshPublishRequest;
  input.id = 'changed'; input.event.tags[0]![1] = 'after'; input.event.created_at = 999;
  assert.equal(req.id, 'p'); assert.equal(req.event.tags[0]?.[1], 'before'); assert.equal(req.event.created_at, 12);
  assert(Object.isFrozen(req) && Object.isFrozen(req.event) && Object.isFrozen(req.event.tags) && Object.isFrozen(req.event.tags[0]));
  const filter = {kinds: [20431], '#t': ['before']}, sub = subscription(filter);
  filter.kinds[0] = 1; filter['#t'][0] = 'after'; assert.deepEqual(sub.filters[0]?.kinds, [20431]); assert.deepEqual(sub.filters[0]?.['#t'], ['before']);
  assert(Object.isFrozen(sub.filters) && Object.isFrozen(sub.filters[0]) && Object.isFrozen(sub.filters[0]?.kinds));
  const signed = event(20431, '', [['t', 'before']]), message = {type: 'mesh.event', subId: sub.subId, result: {event: signed}};
  const one = captureMeshDelivery(message, sub), two = captureMeshDelivery(message, sub);
  assert.deepEqual(one, two); // Stateful owner performs per-sub dedup; the pure capture never hides an event.
  signed.tags[0]![1] = 'mutated'; if ('result' in one) assert.equal(one.result.event.tags[0]?.[1], 'before');
});

test('unreadable getters/proxies/sparse arrays/extra properties reject without getter evaluation', () => {
  let reads = 0;
  const getter = () => {reads++; return 'p';};
  for (const input of [{type: 'mesh.info', get id() {return getter();}}, {get type() {return getter();}, id: 'x'}]) {
    invalid(() => parseMeshRequest(input)); assert.equal(meshFailure(input, 'bad'), null);
  }
  const template = {kind: 1, get content() {return getter();}}; invalid(() => publish(template));
  invalid(() => subscription([{get kinds() {reads++; return [1];}}]));
  invalid(() => parseMeshRequest(new Proxy({}, {ownKeys() {throw new Error('foreign');}, getOwnPropertyDescriptor() {throw new Error('foreign');}})));
  invalid(() => publish(Object.assign(Object.create({kind: 1}), {content: ''})));
  const sparse = new Array(1); invalid(() => subscription(sparse)); invalid(() => publish({kind: 1, content: '', tags: sparse}));
  invalid(() => parseMeshRequest({type: 'mesh.info', id: 'x', [Symbol('extra')]: 1}));
  const tagged = [['t', 'v']]; Object.defineProperty(tagged, 'extra', {value: 1}); invalid(() => publish({kind: 1, content: '', tags: tagged}));
  assert.equal(reads, 0);
  const proxyFilter = new Proxy({kinds: [1]}, {get() {reads++; throw new Error('must not read through proxy');}});
  assert.deepEqual(subscription(proxyFilter).filters[0]?.kinds, [1]); assert.equal(reads, 0);
});

test('signed-frame bound includes JSON escaping and every native-owned field', () => {
  const request = publish({kind: 1, content: '😀'.repeat(1000), tags: [['t', 'mesh']]});
  assert.equal(request.event.content.length, 2000);
  for (const content of ['a'.repeat(8192), '\0'.repeat(1400), '\\'.repeat(4096), '\ud800']) invalid(() => publish({kind: 1, content}));
  invalid(() => publish({kind: 1, content: '', tags: Array.from({length: 257}, () => ['t'])}));
  invalid(() => publish({kind: 1, content: '', tags: [Array(65).fill('t')]}));
  invalid(() => publish({kind: 1, content: '', tags: [[]]}));
  invalid(() => subscription([{ '#t': Array(64).fill('x'.repeat(1024)) }]));
});

test('the exact signed EVENT byte boundary is inclusive and one extra byte is refused', () => {
  const overhead = Buffer.byteLength(JSON.stringify(['EVENT', {kind: 1, content: '', tags: [], created_at: Number.MAX_SAFE_INTEGER,
    id: '0'.repeat(64), pubkey: '0'.repeat(64), sig: '0'.repeat(128)}]));
  const length = MESH_LIMITS.eventBytes - overhead;
  const request = publish({kind: 1, content: 'a'.repeat(length)});
  assert.equal(Buffer.byteLength(JSON.stringify(['EVENT', {...request.event, created_at: Number.MAX_SAFE_INTEGER,
    id: '0'.repeat(64), pubkey: '0'.repeat(64), sig: '0'.repeat(128)}])), 8192);
  invalid(() => publish({kind: 1, content: 'a'.repeat(length + 1)}));
});

test('delivery context, signed byte bounds and result accessors fail closed', () => {
  const req = subscription([{}]);
  invalid(() => captureMeshDelivery({type: 'mesh.closed', subId: undefined}, parseMeshRequest({type: 'mesh.info', id: 'i'}) as MeshSubscribeRequest));
  invalid(() => captureMeshDelivery({type: 'mesh.eose', subId: req.subId, ttl: req.ttl}, req, 'other' as 'live'));
  invalid(() => captureMeshDelivery({type: 'mesh.event', subId: req.subId, result: {event: event(1, 'a'.repeat(8192))}}, req));
  let reads = 0;
  invalid(() => captureMeshResult({type: 'mesh.info.result', id: 'i', get online() {reads++; return false;}, peers: 0,
    limits: {publishTtl: 2, subscribeTtl: 1}}, parseMeshRequest({type: 'mesh.info', id: 'i'})));
  const signed = event();
  Object.defineProperty(signed, 'id', {get() {reads++; return '0'.repeat(64);}, enumerable: true});
  invalid(() => captureMeshDelivery({type: 'mesh.event', subId: req.subId, result: {event: signed}}, req));
  assert.equal(reads, 0);
});
