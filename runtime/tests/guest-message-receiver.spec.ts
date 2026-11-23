import {expect, test} from '@playwright/test';
import {quotaReply, rejectEnvelope} from '../src/guest-envelope';
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

test('refusals use the same request ID and each domain’s own reply type', () => {
  const id = 'request 42';
  for (const [type, fields] of [
    ['relay.publishEncrypted', {ok:false,error:'publish denied'}],
    ['theme.get', {error:'invalid-request'}],
    ['notify.send', {error:'invalid-request'}],
    ['inc.subscribe', {error:'invalid-request'}],
    ['config.registerSchema', {ok:false,code:'invalid-schema',error:'invalid-request'}],
  ] as const) {
    const replies: unknown[] = [];
    rejectEnvelope({data:{type,id,extra:true}} as MessageEvent,
      {postMessage:(reply:unknown) => replies.push(reply)} as Window, [type.split('.')[0]!]);
    expect(replies).toEqual([{type:type+'.result', id, ...fields}]);
  }
  for (const operation of ['list','has','describe','call']) {
    const type = 'cvm.registry.' + operation;
    expect(quotaReply({type,id}, ['cvm'])).toEqual({type:type+'.result',id,error:'policy denied'});
  }
  expect(quotaReply({type:'notify.permission.request',id}, ['notify'])).toEqual({type:'notify.permission.result',id,granted:false});
  expect(quotaReply({type:'theme.unknown',id}, ['theme'])).toBeNull();
  expect(quotaReply({type:'theme.get',id}, [])).toBeNull();
});
