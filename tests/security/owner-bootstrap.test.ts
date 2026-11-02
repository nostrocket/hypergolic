import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerBootstrap, IdentityRestartRequired } from '../../src/security/owner-bootstrap.ts';

const denied = (error: unknown) => error instanceof IdentityRestartRequired
  && error.code === 'IDENTITY_RESTART_REQUIRED' && error.message === 'Restart the app to continue.';

test('claim is synchronous and initializer waits until the same Promise is installed', async () => {
  const order: string[] = [];
  const value = Object.freeze({ owner: 'test-only' });
  const start = createOwnerBootstrap(() => { order.push('claim'); return true; }, async () => { order.push('initialize'); return value; });
  const first = start();
  assert.deepEqual(order, ['claim']);
  const requests = Array.from({ length: 100 }, () => start());
  for (const request of requests) assert.equal(request, first);
  assert.equal(await first, value);
  assert.deepEqual(order, ['claim', 'initialize']);
});

test('initializer reentry receives the already installed Promise', async () => {
  let calls = 0;
  let during: Promise<string> | undefined;
  const start: () => Promise<string> = createOwnerBootstrap(() => true, async () => { calls++; during = start(); return 'test-only'; });
  const first = start();
  assert.equal(await first, 'test-only');
  assert.equal(during, first);
  assert.equal(calls, 1);
});

test('native denial never invokes persistence and is cached', async () => {
  let claims = 0;
  let writes = 0;
  const start = createOwnerBootstrap(() => { claims++; return false; }, async () => { writes++; return 1; });
  const first = start();
  await assert.rejects(first, denied);
  assert.equal(start(), first);
  await assert.rejects(start(), denied);
  assert.equal(claims, 1);
  assert.equal(writes, 0);
});

test('uncertain native throw is sanitized, cached and never admits persistence', async () => {
  let writes = 0;
  let claims = 0;
  const start = createOwnerBootstrap(() => { claims++; throw new Error('private native detail'); }, async () => { writes++; return 1; });
  const first = start();
  await assert.rejects(first, denied);
  assert.equal(start(), first);
  assert.equal(writes, 0);
  assert.equal(claims, 1);
});

test('only literal true grants admission', async () => {
  for (const value of [undefined, null, 1, 'true', {}, Promise.resolve(true)]) {
    let writes = 0;
    const start = createOwnerBootstrap(() => value as boolean, async () => { writes++; return 1; });
    await assert.rejects(start(), denied);
    assert.equal(writes, 0);
  }
});

test('initializer failure remains the same rejected Promise and never reclaims', async () => {
  const failure = new Error('test initialization failure');
  let claims = 0;
  let attempts = 0;
  const start = createOwnerBootstrap(() => { claims++; return true; }, async () => { attempts++; throw failure; });
  const first = start();
  await assert.rejects(first, error => error === failure);
  assert.equal(start(), first);
  await assert.rejects(start(), error => error === failure);
  assert.equal(claims, 1);
  assert.equal(attempts, 1);
});

test('a replacement JavaScript bootstrap cannot initialize while old async work is pending', async () => {
  let consumed = false;
  const claim = () => { if (consumed) return false; consumed = true; return true; };
  let finish: (value: string) => void = () => { throw new Error('Initializer did not start'); };
  let oldStarts = 0;
  let newStarts = 0;
  const old = createOwnerBootstrap(claim, () => { oldStarts++; return new Promise<string>(resolve => { finish = resolve; }); });
  const pending = old();
  await Promise.resolve();
  const replacement = createOwnerBootstrap(claim, async () => { newStarts++; return 'forbidden'; });
  await assert.rejects(replacement(), denied);
  finish('old completion');
  assert.equal(await pending, 'old completion');
  await assert.rejects(replacement(), denied);
  assert.equal(oldStarts, 1);
  assert.equal(newStarts, 0);
});
