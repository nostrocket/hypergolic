import assert from 'node:assert/strict';
import test from 'node:test';
import {createCapabilityBroker} from '../../src/runtime/capability-broker.ts';
import type {NativeRegistration} from '../../src/runtime/capability-protocol.ts';
import {openShellDatabase} from '../../src/storage/database.ts';
import {LIMITS} from '../../src/storage/ports.ts';
import {NativeLeases} from '../runtime/native-leases.ts';
import {hex, setup} from '../storage/harness.ts';
import {loadTrace, readableError, sends} from './trace.mts';

for (const name of ['storage', 'storage-examples', 'restore', 'storage-quota']) {
  test('Lean ' + name + ' matches the SQLite storage broker', async t => {
    const {header, steps} = loadTrace(name);
    const fixture = await setup(t);
    let db = fixture.database;
    const native = new NativeLeases();
    const windows = new Map<number, NativeRegistration>();
    const ports = new Map<number, {registration: NativeRegistration; broker: ReturnType<typeof createCapabilityBroker>}>();
    for (const step of steps) {
      const row = step.input;
      if (row.t === 'create') {
        const tag = (key: string) => row.manifest.tags.find(([type]: string[]) => type === key)[1];
        const registration: NativeRegistration = {sessionId: 'window-' + row.w, generation: 'generation-' + row.w,
          instanceId: 'instance-' + row.inst, user: hex(1), epoch: 0, publisher: row.manifest.pubkey,
          appId: tag('d'), version: tag('x'), fixture: 'published', domains: ['storage']};
        windows.set(row.w, registration);
        const store = db.bindStorage({...registration, assertActive() {}});
        if (header.restore) {
          const [[scope, entries]] = header.restore.storage;
          assert.deepEqual([scope.key.publisher, scope.key.d, scope.hash], [registration.publisher, registration.appId, registration.version]);
          for (const [key, value] of entries) await store.port.set(key, value);
          store.revoke();
          await db.close();
          db = await openShellDatabase(fixture.sqlite, 'ios');
        } else if (header.config.storageQuota !== undefined) {
          // Leave the same byte budget available in Hypergolic's larger namespace.
          const half = (LIMITS.namespaceBytes - header.config.storageQuota) / 2;
          await store.port.set('a', 'x'.repeat(half - 1));
          await store.port.set('b', 'x'.repeat(half - 1));
          store.revoke();
        } else store.revoke();
      } else if (row.t === 'hello') {
        const registration = windows.get(row.w)!;
        assert.equal(row.ports.length, 1);
        ports.set(row.ports[0], {registration, broker: createCapabilityBroker(db, native, {registration, assertActive() {}})});
      } else if (row.t === 'message') {
        const session = ports.get(row.port);
        if (!session) {
          // Unbound port transport is outside this broker's scope.
          assert.equal(name, 'restore');
          assert.equal(step.index, 1);
          continue;
        }
        const token = native.add(session.registration, row.msg);
        await session.broker.dispatch(token);
        const reply = native.results.get(token);
        assert.ok(reply && typeof reply === 'object', 'Missing reply at step ' + step.index);
        let actual = readableError(reply);
        const [{port, msg}] = sends(step);
        assert.equal(port, row.port);
        assert.equal(sends(step).length, 1);
        if (actual.keys && msg.keys) actual = {...actual, keys: [...actual.keys].sort()};
        assert.deepEqual(actual, readableError(msg), 'Wire reply at step ' + step.index);
        if ('error' in reply) {
          const category = msg.error === 'quota exceeded' ? 'storage quota exceeded' : 'invalid storage request';
          assert.ok(['quota exceeded', 'invalid request'].includes(msg.error));
          assert.equal(reply.error, category);
        }
        if (name === 'storage-quota') {
          const store = db.bindStorage({...session.registration, assertActive() {}});
          assert.equal(await store.port.get(row.msg.key), null);
          store.revoke();
        }
      } else assert.ok(row.t === 'load' || (name === 'restore' && row.t === 'portClosed'));
    }
    await db.close();
  });
}
