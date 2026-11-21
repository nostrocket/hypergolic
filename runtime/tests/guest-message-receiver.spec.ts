import {expect, test} from '@playwright/test';
import {guestMessageReceiver} from '../src/guest-message-receiver';

test('a busy guest receives bounded quota replies and can release its existing work', () => {
  const replies: unknown[] = [], dispatched: string[] = [];
  const source = {postMessage(value: unknown) { replies.push(value); }} as unknown as Window;
  const frame = {contentWindow: source} as HTMLIFrameElement;
  const receive = guestMessageReceiver(frame, source, {
    domains: ['storage', 'relay', 'resource', 'outbox'], live: () => true, closed: () => false,
    routing: {connect: () => false} as Parameters<typeof guestMessageReceiver>[2]['routing'],
    keys:null, sendMedia:null,
    dispatch(event) { dispatched.push(event.data.type); },
  });
  const send = (data: object) => receive({source, data, ports: [], isTrusted: true} as unknown as MessageEvent);
  for (let i = 0; i < 64; i++) send({type:'storage.keys', id:String(i)});
  send({type:'storage.keys', id:'waiting'});
  send({type:'relay.subscribe', id:'next', subId:'stream'});
  send({type:'resource.cancel', id:'in-flight'});
  send({type:'relay.close', id:'closing', subId:'open'});
  send({type:'outbox.close', id:'closing-outbox', subId:'outbox'});
  send({type:'unknown', id:'ignored'});
  send({type:'storage.keys', id:'x'.repeat(129)});
  expect(replies).toEqual([
    {type:'storage.keys.result', id:'waiting', error:'quota-exceeded'},
    {type:'relay.closed', subId:'stream', reason:'quota-exceeded'},
  ]);
  expect(dispatched).toHaveLength(67);
  expect(dispatched.slice(-3)).toEqual(['resource.cancel', 'relay.close', 'outbox.close']);
});
