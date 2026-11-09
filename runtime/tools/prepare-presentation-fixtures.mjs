import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const pins=JSON.parse(await readFile(new URL('fixtures/reviewed-presentation-manifest.json',root),'utf8'));
function verify(bytes,pin) {
  assert.equal(bytes.length,pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);
  new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return bytes;
}
async function download(pin) {
  const response=await fetch(pin.url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  assert(response.ok&&response.body,`Pinned presentation fixture ${pin.appId} unavailable (HTTP ${response.status})`);
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;assert(length<=pin.bytes);chunks.push(chunk);}
  return verify(Buffer.concat(chunks,length),pin);
}
export async function preparePresentationFixtures() {
  const cache=new URL('.test-fixtures/presentation/',root);await mkdir(cache,{recursive:true});
  for(const pin of pins) {
    assert(['emoji-browser','creator-signals','mapplets','feed-builder','emoji-pack-creator'].includes(pin.appId));
    assert(/^[a-f0-9]{64}$/.test(pin.eventId)&&/^[a-f0-9]{64}$/.test(pin.sha256));
    assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=1024*1024);
    const url=new URL(pin.url);
    assert.equal(url.protocol,'https:');
    const hosts={'emoji-browser':'cdn.hzrd149.com','creator-signals':'blssm.us','mapplets':'r2a.primal.net','feed-builder':'cdn.hzrd149.com','emoji-pack-creator':'blssm.us'};
    assert.equal(url.hostname,hosts[pin.appId]);
    assert.equal(url.port+url.username+url.password+url.search+url.hash,'');
    const path=pin.appId==='mapplets'?'/uploads2/1/0c/be/'+pin.sha256+'.html':'/'+pin.sha256;
    assert.equal(url.pathname,path);
    assert.equal(createHash('sha256').update(pin.sha256+' /index.html\n').digest('hex'),pin.aggregateHash);
    const destination=new URL(pin.appId+'.html',cache);
    try{verify(await readFile(destination),pin);continue;}catch(error){if(error.code!=='ENOENT')throw error;}
    const source=process.env.HYPERGOLIC_PRESENTATION_FIXTURES;
    const bytes=source?verify(await readFile(join(source,pin.eventId+'.html')),pin):await download(pin);
    const temporary=fileURLToPath(destination)+'.'+process.pid+'.tmp';
    await writeFile(temporary,bytes);await rename(temporary,destination);
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await preparePresentationFixtures();
