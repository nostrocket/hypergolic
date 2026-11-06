import { expect, test } from '@playwright/test';
import { createNativeClient } from '../src/native-client';

for (const scenario of ['recipient throws', 'ACK throws', 'malformed terminal', 'stale generation']) {
  test(`scoped stream admission after ${scenario}`, () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {configurable:true, value:{
      addEventListener() {}, removeEventListener() {}, setTimeout:()=>1, clearTimeout() {},
    }});
    let receive: ((event: {data: unknown}) => void) | undefined;
    const sent: {type: string; sequence: number; streamSequence?: number; message?: string}[] = [];
    const client = createNativeClient({
      addEventListener(_type, listener) {receive = listener;},
      postMessage(text) {
        const envelope = JSON.parse(text);
        sent.push(envelope);
        if (envelope.type === 'relay-stream-ack' && scenario === 'ACK throws') throw new Error('bridge closed');
      },
    }, 'generation');
    let delivered = 0;
    try {
      for (let index = 0; index < 4; index++) {
        client.subscribe({type:'relay.subscribe', id:`request-${index}`, subId:`stream-${index}`,
          relay:`wss://peer-${index}.nostr.net`, filters:[{kinds:[1],limit:1}]}, () => {
          delivered++;
          if (scenario === 'recipient throws') throw new Error('renderer delivery failed');
        });
      }
      expect(sent.map(item => item.type)).toEqual(Array(3).fill('relay-stream'));
      const message = {type:'relay.closed', subId:scenario === 'malformed terminal' ? 'other' : 'stream-0'};
      receive!({data:JSON.stringify({type:'capability.stream',
        sessionId:scenario === 'stale generation' ? 'old' : 'generation',
        sequence:sent[0]!.sequence, delivery:1, response:JSON.stringify(message),
      })});

      const followup = sent.slice(3);
      if (scenario === 'recipient throws') {
        expect(delivered).toBe(1);
        expect(followup.map(item => item.type)).toEqual(['relay-stream-ack','relay-stream']);
        expect(followup[0]!.streamSequence).toBe(sent[0]!.sequence);
        expect(JSON.parse(followup[1]!.message!).subId).toBe('stream-3');
      } else {
        const expected = scenario === 'ACK throws' ? ['relay-stream-ack'] :
          scenario === 'malformed terminal' ? ['capability'] : [];
        expect(followup.map(item => item.type)).toEqual(expected);
      }
    } finally {
      client.destroy();
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}
