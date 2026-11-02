import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { verifyQueryEvent } from '../../../src/network/relay-query-contract.ts';
import { profileFromEvents } from '../../../src/identity/identity-contract.ts';
const output = process.argv[2];
if (!output) throw Error('Usage: node observe-profile.mjs OUTPUT.json');
const relay = 'wss://nos.lol', subscription = 'identity_' + randomUUID().replaceAll('-', '');
const filters = [{ kinds: [0], limit: 8 }], samples = [];
const socket = new WebSocket(relay);
await new Promise((done, reject) => {
  const timeout = setTimeout(() => { socket.terminate(); reject(Error('public profile observation timed out')); }, 15000);
  socket.on('open', () => socket.send(JSON.stringify(['REQ', subscription, ...filters])));
  socket.on('error', error => { clearTimeout(timeout); reject(error); });
  socket.on('message', bytes => {
    try {
      const frame = JSON.parse(bytes.toString());
      if (frame[0] === 'EVENT' && frame[1] === subscription) {
        const event = verifyQueryEvent(frame[2], filters);
        if (Buffer.byteLength(event.content) > 1800) return;
        const profile = profileFromEvents([event]);
        if (!profile?.name || profile.name.length > 64) return;
        samples.push({ relay, user: event.pubkey, event, profile });
      } else if (frame[0] === 'EOSE' && frame[1] === subscription) {
        clearTimeout(timeout); socket.send(JSON.stringify(['CLOSE', subscription])); socket.close();
        if (samples.length === 0) reject(Error('No bounded independently validated public profile sample')); else done();
      }
    } catch { /* Ignore unrelated/malformed public samples, never accept them as verified. */ }
  });
});
await writeFile(resolve(output), JSON.stringify(samples[0], null, 2) + '\n', { flag: 'wx' });
console.log('PASS independent public profile observation; exact signed source saved privately.');
