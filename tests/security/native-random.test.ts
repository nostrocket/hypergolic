import test from 'node:test';
import assert from 'node:assert/strict';
import { EntropyUnavailableError, installNativeRandom } from '../../src/security/native-random.ts';

test('native random fills precisely an integer view and preserves unrelated crypto methods', () => {
  const subtle = {};
  const target = { crypto: { subtle, getRandomValues: () => { throw new Error('Old provider must not run'); } } };
  let calls = 0;
  const random = installNativeRandom(target, bytes => { calls++; bytes.fill(73); });
  const buffer = new Uint8Array(12).fill(9);
  const view = new Uint16Array(buffer.buffer, 2, 3);
  assert.equal(random(view), view);
  assert.deepEqual([...buffer], [9, 9, 73, 73, 73, 73, 73, 73, 9, 9, 9, 9]);
  assert.equal(calls, 2);
  assert.equal(target.crypto.subtle, subtle);
  assert.throws(() => Object.defineProperty(target.crypto, 'getRandomValues', { value: Math.random }), TypeError);
  assert.throws(() => Object.defineProperty(target, 'crypto', { value: { getRandomValues: Math.random } }), TypeError);
});

test('repeated installation only accepts the exact provider registered by this module', () => {
  const target = {};
  const fill = (bytes: Uint8Array) => bytes.fill(1);
  const first = installNativeRandom(target, fill);
  assert.equal(installNativeRandom(target, fill), first);
  assert.throws(() => installNativeRandom(target, bytes => bytes.fill(2)), EntropyUnavailableError);
  const incompatible = Object.defineProperty({}, 'crypto', { get: () => ({}), configurable: false });
  assert.throws(() => installNativeRandom(incompatible, fill), EntropyUnavailableError);
});

test('invalid views and oversized requests never reach the native provider', () => {
  let calls = 0;
  const random = installNativeRandom({}, bytes => { calls++; bytes.fill(1); });
  for (const invalid of [[], new DataView(new ArrayBuffer(4)), new Float32Array(1), new Float64Array(1), null]) {
    assert.throws(() => random(invalid as unknown as Uint8Array), TypeError);
  }
  assert.throws(() => random(new Uint8Array(65_537)), RangeError);
  assert.equal(calls, 1);
  random(new Uint8Array(65_536));
  random(new BigUint64Array(1));
  assert.equal(calls, 3);
});

test('native failure rejects startup, sanitizes its error, and clears partial output', () => {
  let fail = false;
  const random = installNativeRandom({}, bytes => { bytes.fill(7); if (fail) throw new Error('private native detail'); });
  fail = true;
  const buffer = new Uint8Array(8).fill(1);
  assert.throws(() => random(buffer.subarray(2, 6)), error => error instanceof EntropyUnavailableError && !error.message.includes('private'));
  assert.deepEqual([...buffer], [1, 1, 0, 0, 0, 0, 1, 1]);
  assert.throws(() => installNativeRandom({}, () => { throw new Error('offline'); }), EntropyUnavailableError);
  const target = { crypto: Object.freeze({}) };
  assert.throws(() => installNativeRandom(target, () => undefined), EntropyUnavailableError);
  assert.throws(() => installNativeRandom({}, undefined as never), EntropyUnavailableError);
});
