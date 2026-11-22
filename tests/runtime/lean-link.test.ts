import assert from 'node:assert/strict';
import {runtimeModule} from '../reference-shell/runtime-module.mts';
import test from 'node:test';
import {loadTrace, sends} from '../reference-shell/trace.mts';

for (const name of ['link', 'link-denied']) {
  test('Lean ' + name + ' preserves HTTPS handoff and decision at the guest adapter', async t => {
    const {steps} = loadTrace(name);
    const [request, decision] = steps.slice(-2);
    const {createLinkAdapter} = await runtimeModule(t, '/src/link-adapter.ts');
    const native = Promise.withResolvers<object>();
    const calls: Record<string, unknown>[] = [];
    const adapter = createLinkAdapter({request(wire: Record<string, unknown>) {calls.push(wire); return native.promise;}}, () => () => true);
    const delivered = Promise.withResolvers<void>();
    const replies: object[] = [];
    adapter.handleMessage('trace-window', request.input.msg, (msg: object) => {replies.push(msg); delivered.resolve();});
    assert.deepEqual(calls, [request.input.msg]);
    const [captured] = calls;
    assert.equal(captured.url, request.outputs[0].call.details.url);
    assert.deepEqual(captured.options, {label: request.outputs[0].call.details.label});
    assert.deepEqual(replies, []);
    const allowed = decision.input.reply.allowed;
    // The decision is controlled native input. No OS link opener is invoked.
    native.resolve({type: 'link.open.result', id: captured.id, status: allowed ? 'opened' : 'denied',
      ...(allowed ? {} : {error: 'user-denied'})});
    await delivered.promise;
    assert.deepEqual(replies, sends(decision).map(row => row.msg));
  });
}
