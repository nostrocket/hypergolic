import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const html = Buffer.from(`<!doctype html><html><head><title>Startup admission</title></head><body><output>starting</output>
<script>
  const api = window.napplet;
  const run = Promise.all([
    api.identity.getPublicKey(), api.identity.getProfile(), api.identity.getRelays(), api.identity.getFollows(),
    api.relay.query({ kinds: [1], limit: 3 }),
    api.storage.setItem('queue', 'original').then(() => api.storage.getItem('queue'))
      .then(value => api.storage.removeItem('queue').then(() => value)),
  ]);
  const publish = api.relay.publish({kind: 1, created_at: 1700000000, tags: [], content: 'fixture-only'})
    .then(() => 'sent', () => 'denied');
  Promise.all([run,publish]).then(([results,outcome]) => {
    document.querySelector('output').textContent = JSON.stringify({storage:results[5],publish:outcome});
  }, error => {document.querySelector('output').textContent = 'failed: ' + error.message;});
</script></body></html>`);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test('valid startup requests cross the bridge once with native deferral while publication still fails fast', async ({page}) => {
  const generation = randomUUID(), htmlHash = digest(html), version = digest(htmlHash + ' /index.html\n');
  await page.addInitScript(({generation, htmlHash, version, body, byteLength}) => {
    if (window !== window.top) return;
    const listeners = new Set<(value: {data: string}) => void>();
    const queue: Array<() => void> = [];
    const calls: Array<{type: string; deferred: boolean; sequence: number}> = [];
    const stored = new Map<string, string>();
    let active = 0, peak = 0;
    const emit = (value: unknown) => {for (const listener of listeners) listener({data:JSON.stringify(value)});};
    const pump = () => {while (active < 4 && queue.length) queue.shift()!();};
    Object.defineProperty(window,'__startupCalls',{value:() => ({calls,peak})});
    Object.defineProperty(window,'HypergolicHost',{value:{
      addEventListener(_type: string, listener: (value: {data: string}) => void) {listeners.add(listener);},
      removeEventListener(_type: string, listener: (value: {data: string}) => void) {listeners.delete(listener);},
      postMessage(raw: string) {
        const req = JSON.parse(raw);
        if (req.type === 'artifact.read') {
          emit({type:'artifact.chunk',sessionId:generation,sequence:req.sequence,base64:body,
            byteLength,totalBytes:byteLength,done:true,publisher:'1'.repeat(64),eventId:'2'.repeat(64),
            appId:'startup-admission',htmlHash,version,domains:['identity','relay','storage']});
        }
        if (req.type !== 'capability') return;
        const wire = JSON.parse(req.message);
        calls.push({type:wire.type,deferred:req.deferred === true,sequence:req.sequence});
        if (req.deferred !== true) throw Error('Unexpected fast-path request');
        queue.push(() => {
          peak = Math.max(peak, ++active);
          setTimeout(() => {
            const reply = {type:wire.type+'.result',id:wire.id};
            let result;
            switch (wire.type) {
              case 'identity.getPublicKey': result = {...reply,pubkey:'3'.repeat(64)}; break;
              case 'identity.getProfile': result = {...reply,profile:null}; break;
              case 'identity.getRelays': result = {...reply,relays:{}}; break;
              case 'identity.getFollows': result = {...reply,pubkeys:[]}; break;
              case 'relay.query': result = {...reply,events:[]}; break;
              case 'storage.set': stored.set(wire.key,wire.value); result = reply; break;
              case 'storage.get': result = {...reply,value:stored.get(wire.key)??null}; break;
              case 'storage.remove': stored.delete(wire.key); result = reply; break;
              default: throw Error('Unexpected deferred request');
            }
            active--;
            emit({type:'capability.result',sessionId:generation,sequence:req.sequence,response:JSON.stringify(result)});
            pump();
          }, 75);
        });
        pump();
      },
    }});
  },{generation,htmlHash,version,body:html.toString('base64'),byteLength:html.length});
  await page.goto('/assets/runtime/index.html?sessionId=' + generation + '&source=published');
  await expect(page.frameLocator('#napplet').locator('output')).toHaveText('{"storage":"original","publish":"denied"}');
  const observed = await page.evaluate(() => (window as unknown as {__startupCalls(): {calls: Array<{type:string;deferred:boolean;sequence:number}>;peak:number}}).__startupCalls());
  expect(observed.peak).toBe(4);
  expect(observed.calls.map(call => call.type)).toEqual(['identity.getPublicKey','identity.getProfile','identity.getRelays','identity.getFollows',
    'relay.query','storage.set','storage.get','storage.remove']);
  expect(observed.calls.every(call => call.deferred)).toBe(true);
  expect(observed.calls.map(call => call.sequence)).toEqual([1,2,3,4,5,6,7,8]);
});
