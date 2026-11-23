import assert from 'node:assert/strict';
import test from 'node:test';
import {setup, reviewReady} from '../routing/harness.ts';
import {loadTrace, readableError, sends} from '../reference-shell/trace.mts';

for (const name of ['inc', 'inc-channel', 'inc-named']) {
  test('Lean ' + name + ' matches two registered routing endpoints', async t => {
    const {header, steps} = loadTrace(name);
    const host = await setup(t);
    const aliases = new Map<string, string>();
    const sessions = new Map<number, typeof host.source>();
    const hosts = [host.source, host.target];
    const allocateId = host.native.newChannelId;
    for (const step of steps) {
      const row = step.input;
      if (row.t === 'create' || row.t === 'load') continue;
      if (row.t === 'hello') {
        const endpoint = hosts[row.w - 1]!;
        const alias = header.config.endpointName?.find(([id]: [number, string]) => id === row.w)?.[1] ?? 'endpoint-' + row.w;
        host.native.newChannelId = allocateId;
        sessions.set(row.ports[0], endpoint);
        await host.register(endpoint);
        const peer = host.peerId(endpoint);
        assert.ok(peer);
        aliases.set(alias, peer);
        host.native.newChannelId = () => header.config.inc?.channelName[0][1] ?? 'c-0';
        continue;
      }
      const expected = sends(step).map(({port, msg}) => {
        const message = {...msg};
        for (const key of ['sender', 'peer']) if (key in message) {
          assert.ok(aliases.has(message[key]));
          message[key] = aliases.get(message[key]);
        }
        return {port, msg: readableError(message)};
      });
      const before = host.sent.length;
      const endpoint = sessions.get(row.port)!;
      let reply;
      if (row.t === 'portClosed') host.broker.close(endpoint.generation);
      else {
        assert.equal(row.t, 'message');
        const message = {...row.msg};
        const knownTarget = aliases.get(message.target);
        if (knownTarget) message.target = knownTarget;
        host.setFocus(endpoint.generation);
        const call = host.dispatch(endpoint, message);
        if (knownTarget || message.type === 'inc.subscribe') {
          const review = await reviewReady(host.reviews);
          assert.equal(review.request.kind, knownTarget ? 'channel' : 'topic');
          host.reviews.decide(review.id, {allow: true});
        }
        await call.promise;
        reply = call.reply();
      }
      const actual = host.sent.slice(before).map(({generation, message}) => {
        const recipient = [...sessions].find(([, session]) => session.generation === generation);
        assert.ok(recipient);
        const msg = {...message};
        // NAP-INC permits a reason on explicit close. Require the real reason when present.
        if (row.msg?.type === 'inc.channel.close' && 'reason' in msg) {
          assert.equal(msg.reason, 'closed');
          delete msg.reason;
        }
        return {port: recipient[0], msg};
      });
      if (reply?.error) {
        assert.equal(row.msg.type, 'inc.channel.open');
        assert.equal(reply.error, 'peer unavailable');
      }
      if (reply != null) actual.push({port: row.port, msg: readableError(reply)});
      assert.deepEqual(actual, expected, 'INC delivery at step ' + step.index);
    }
  });
}
