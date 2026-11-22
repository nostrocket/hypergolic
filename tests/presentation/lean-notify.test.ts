import assert from 'node:assert/strict';
import test from 'node:test';
import {setup} from '../presentation/harness.ts';
import {loadTrace, sends} from '../reference-shell/trace.mts';

test('Lean notify matches permission, visible card and click delivery', async t => {
  const {steps} = loadTrace('notify');
  const host = await setup(t);
  const dispatch = (msg: unknown) => host.dispatch(host.source, msg);
  const messages = (index: number) => sends(steps[index]).map(row => row.msg);
  // The shell announces controls at registration. The model emits them on first use.
  await dispatch({type: 'notify.__register'}).promise;
  const denied = dispatch(steps[3].input.msg);
  await denied.promise;
  assert.deepEqual([...host.sent.splice(0).map(row => row.message), denied.reply()], messages(3));
  assert.equal(host.broker.getSnapshot().cards.length, 0);

  const request = dispatch(steps[4].input.msg);
  const review = await host.review();
  assert.equal(request.reply(), undefined);
  assert.equal(review.origin.generation, host.source.generation);
  host.broker.decide(review.id, steps[5].input.reply.allowed);
  await request.promise;
  assert.deepEqual([request.reply()], messages(5));

  const shown = dispatch(steps[6].input.msg);
  await shown.promise;
  const [card] = host.broker.getSnapshot().cards;
  const shownEffect = steps[6].outputs.find(row => row.t === 'effect');
  assert.ok(shownEffect);
  const effect = shownEffect.effect.args;
  assert.deepEqual([card.title, card.body, card.priority, card.actions, card.origin.generation],
    [effect.title, effect.body, effect.priority, effect.actions, host.source.generation]);
  // The shell generates its own opaque notification ID. Bind it once, then reuse it on click.
  const [receipt] = messages(6);
  assert.equal(receipt.notificationId, effect.notificationId);
  assert.equal(steps[7].input.event.args.notificationId, receipt.notificationId);
  assert.ok(card.id);
  assert.deepEqual(shown.reply(), {...receipt, notificationId: card.id});
  assert.equal(messages(7)[0].notificationId, receipt.notificationId);
  host.broker.interact(card.id);
  assert.deepEqual(host.sent, [{generation: host.source.generation, message: {...messages(7)[0], notificationId: card.id}}]);
  assert.equal(host.broker.getSnapshot().cards.length, 0);
});
