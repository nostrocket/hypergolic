import assert from 'node:assert/strict';
import test from 'node:test';
import {runtimeModule} from '../reference-shell/runtime-module.mts';
import {loadTrace, sends} from '../reference-shell/trace.mts';

for (const name of ['theme', 'theme-full']) {
  test('Lean ' + name + ' matches active theme updates and reads', async t => {
    const {steps} = loadTrace(name);
    const {createShellTheme} = await runtimeModule(t, '/src/shell-theme.ts');
    const appearance = new EventTarget();
    Object.defineProperty(globalThis, 'window', {configurable: true, value: {matchMedia: () => appearance}});
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {documentElement: {style: {}}, body: {style: {}}}});
    t.after(() => {Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document');});
    const published: object[] = [];
    const host = createShellTheme((theme: object) => published.push(theme));
    try {
      // Hypergolic starts with its system palette. Replay from the first active-theme update.
      for (const step of steps.slice(name === 'theme' ? 4 : 3)) {
        const [expected] = sends(step);
        assert.equal(expected.port, 7);
        if (step.input.t === 'event') {
          const envelope = host.theme.publishTheme(step.input.event.theme);
          assert.deepEqual(envelope, expected.msg);
          assert.deepEqual(published.splice(0), [expected.msg.theme]);
        } else {
          assert.equal(step.input.port, expected.port);
          const replies: object[] = [];
          host.theme.handler.handleMessage('guest', step.input.msg, (msg: object) => replies.push(msg));
          assert.deepEqual(replies, [expected.msg]);
          assert.deepEqual(published, []);
        }
      }
    } finally {host.close();}
  });
}
