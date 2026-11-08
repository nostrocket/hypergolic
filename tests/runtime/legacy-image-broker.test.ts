import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyImageBroker} from '../../src/runtime/legacy-image-broker.ts';
import {createResourceBroker} from '../../src/resources/resource-broker.ts';
import {createResourceService, type ResourceResolvers} from '../../src/resources/resource-service.ts';
import {createResourceTransfers} from '../../src/resources/resource-transfers.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {NativeLeases} from './native-leases.ts';
const registration: NativeRegistration = {sessionId: 'legacy', generation: 'native-one', epoch: 1, user: '1'.repeat(64),
 publisher: 'c2f1ab4e6a577dd8980b57e15986ed92830b95a94f374192235563532b5cac20', appId: 'recipe-cards',
 version: '92d5639e1da2a0b9ac6bbb9d41d67b0026c15ed614e2d553f8ad2e4e4e896ecc', instanceId: 'instance', fixture: 'published', domains: [],
 legacyReadOnly: {profile: 'legacy-read-only-v1', consent: true, eventId: 'b70911af4382baded327ce6af4b595197ff7a4781e3704b9f066a74f68b48a07',
 htmlHash: '9067048a9ce80d7e79ea76b960acc88aa53645754ec4e7549de1c1525a690194', relays: ['wss://relay.example.org']}};
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ZkAAAAASUVORK5CYII=', 'base64'));
const request = (id = 'one', url = 'https://assets.example.com/image.png') => ({type: 'legacy.image.bytes', id, url});
function harness(t: TestContext, resolve?: ResourceResolvers['https']) {
 let active = true, calls = 0;
 const native = new NativeLeases(), host = {service: createResourceService({https: async (...args) => {calls++; return resolve ? resolve(...args) : png;},
   servers: () => [], sha256: async () => 'a'.repeat(64)}), transfers: createResourceTransfers(() => native.newInstanceId())};
 const owner = {registration, assertActive() {if (!active) throw new Error('Owner revoked');}};
 const broker = createLegacyImageBroker(native, host, owner); t.after(() => broker.revoke());
 const start = (value: unknown = request(), captured = registration) => {const token = native.add(captured, value); return {token, done: broker.dispatch(token)};};
 const dispatch = async (value: unknown = request(), captured = registration): Promise<any> => {const {token, done} = start(value, captured); await done; return native.results.get(token);};
 return {native, host, owner, broker, dispatch, start, calls: () => calls, revokeOwner() {active = false;}};
}
test('exact zero-domain source gets bounded raster bytes through private one-use chunks; generic Resource stays denied', async t => {
 const h = harness(t), reply = await h.dispatch(); assert.equal(reply.type, 'legacy.image.bytes.result'); assert.equal(reply.transfer.mime, 'image/png');
 assert.equal(reply.transfer.length, png.length); assert.equal(h.calls(), 1); assert.deepEqual(registration.domains, []);
 const generic = createResourceBroker(h.host, h.owner); t.after(() => generic.revoke());
 assert.equal(await generic.dispatch({type: 'resource.bytes', id: 'generic', url: request().url}, {nativeToken: 'unused', assertActive() {}}), null);
 const chunk = {type: 'legacy.image.__chunk', id: 'read', handle: reply.transfer.handle, offset: 0};
 assert.deepEqual(await h.dispatch(chunk), {type: 'legacy.image.__chunk.result', id: 'read', base64: Buffer.from(png).toString('base64')});
 assert.equal(await h.dispatch(chunk), null);
});
test('foreign account, generation, pin, grants and consent cannot fetch or borrow another realm transfer', async t => {
 const h = harness(t);
 for (const patch of [{user: '4'.repeat(64)}, {generation: 'other'}, {epoch: 2}, {version: '5'.repeat(64)}, {domains: ['resource']},
   {legacyReadOnly: {...registration.legacyReadOnly!, consent: false}}, {legacyReadOnly: undefined}]) {
   assert.equal(await h.dispatch(request(), {...registration, ...patch} as NativeRegistration), null);
 }
 assert.equal(h.calls(), 0);
 const image = await h.dispatch(request('valid'));
 assert.equal(await h.dispatch({type: 'legacy.image.__chunk', id: 'foreign', handle: image.transfer.handle, offset: 0}, {...registration, user: '4'.repeat(64)}), null);
 assert.equal((await h.dispatch({type: 'legacy.image.__chunk', id: 'valid-chunk', handle: image.transfer.handle, offset: 0})).base64, Buffer.from(png).toString('base64'));
});
test('no generic resource, non-HTTPS, headers, hints, bulk or active MIME can become a legacy image', async t => {
 const h = harness(t);
 for (const [index, value] of [
   {...request(), type: 'resource.bytes'}, {...request(), type: 'legacy.image.bytesMany'}, {...request(), headers: {}}, {...request(), servers: []},
   request('http', 'http://assets.example.com/a'), request('data', 'data:image/png;base64,AAAA'),
   request('private', 'https://127.0.0.1/a'), request('credentials', 'https://user:pass@assets.example.com/a'),
 ].entries()) {const result = await h.dispatch({...value, id: 'denied-' + index}); assert.equal(result?.transfer, undefined);}
 assert.equal(h.calls(), 0);
 for (const body of ['<html>active</html>', '<svg></svg>', 'plain text']) {
   const other = harness(t, async () => new TextEncoder().encode(body));
   const result = await other.dispatch(); assert.equal(result.transfer, undefined); assert.match(result.error, /blocked-by-policy|decode-failed/);
 }
});
test('cancel drops staged handles; revocation and late completion never deliver a transfer', async t => {
 const h = harness(t), image = await h.dispatch(); await h.dispatch({type: 'legacy.image.cancel', id: 'one'});
 assert.equal(await h.dispatch({type: 'legacy.image.__chunk', id: 'cancelled', handle: image.transfer.handle, offset: 0}), null);
 let complete!: (bytes: Uint8Array<ArrayBuffer>) => void;
 const held = harness(t, async () => new Promise(resolve => {complete = resolve;}));
 const work = held.start(); await new Promise(resolve => setImmediate(resolve));
 held.revokeOwner(); complete(png); await work.done; assert.equal(held.native.results.get(work.token), null);
});
test('cancelling an in-flight request prevents successful staging even when resolver ignores abort', async t => {
 let complete!: (bytes: Uint8Array<ArrayBuffer>) => void;
 const h = harness(t, async () => new Promise(resolve => {complete = resolve;}));
 const work = h.start(); await new Promise(resolve => setImmediate(resolve));
 await h.dispatch({type: 'legacy.image.cancel', id: 'one'}); complete(png); await work.done;
 assert.equal((h.native.results.get(work.token) as any)?.transfer, undefined);
});
