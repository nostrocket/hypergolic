import assert from 'node:assert/strict';
import {readBlob, readableError} from '../reference-shell/trace.mts';
import test from 'node:test';
import {setup} from './config-harness.ts';

type Message = {type: string; error?: string};
type ConfigInput = {t: 'message'; port: number; msg: Message}
  | {t: 'event'; event: {t: string; domain: string; event: string; args: {window: number; values: Record<string, string>}}};
type Output = {step: number; outputs: {t: string; port: number; msg: Message}[]};

function readTrace<T>(name: string, blob: string): T[] {
  return readBlob(new URL('./fixtures/lean-config/' + name, import.meta.url), blob);
}

test('Config matches the seven post-bootstrap steps of the pinned Lean trace', async t => {
  // The first input is model configuration. The next three construct its guest and port.
  const inputs = (readTrace<ConfigInput>('config.in.ndjson', '257726064a17fca209fef7613479ef6090b37fb2')).slice(4);
  const expected = (readTrace<Output>('config.out.ndjson', '661163f4aaf16a05e08e68d3d74170eb6a731fb9')).slice(3);
  assert.equal(inputs.length, 7);
  assert.equal(expected.length, inputs.length);
  const host = await setup(t);
  for (const [index, input] of inputs.entries()) {
    const start = host.sent.length;
    const actual: Message[] = [];
    if (input.t === 'message') {
      assert.equal(input.port, 7);
      const call = host.dispatch(input.msg);
      await call.promise;
      const reply = call.reply();
      assert.notEqual(reply, undefined, 'Expected the host to finish the request');
      if (reply !== null) actual.push(reply);
    } else {
      assert.equal(input.t, 'event');
      assert.deepEqual([input.event.t, input.event.domain, input.event.event, input.event.args.window], ['nap', 'config', 'edited', 1]);
      await host.broker.open(host.source.generation);
      const review = host.broker.getSnapshot().review;
      assert.ok(review, 'Expected the shell settings editor to open');
      await host.broker.commit(review.id, input.event.args.values, {});
    }
    for (const push of host.sent.slice(start)) {
      assert.equal(push.generation, host.source.generation);
      actual.push(push.message);
    }
    const step = expected[index]!;
    assert.equal(step.step, index + 3);
    const messages = step.outputs.map(output => {
      assert.equal(output.t, 'send');
      assert.equal(output.port, 7);
      return readableError(output.msg);
    });
    assert.deepEqual(actual.map(readableError), messages, 'Wire messages differ at Lean step ' + step.step);
  }
});
