import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fixtures/legacy-manifest.json', root), 'utf8'));
function verify(bytes, pin) {
  assert.equal(bytes.length, pin.bytes, 'Legacy fixture byte length changed');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, 'Legacy fixture digest changed');
  new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  return bytes;
}
async function download(pin) {
  const response = await fetch(pin.url, {redirect: 'error', signal: AbortSignal.timeout(15_000)});
  assert(response.ok && response.body, 'Pinned legacy fixture download unavailable');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > pin.bytes) throw new Error('Legacy fixture download exceeds reviewed length');
    chunks.push(chunk);
  }
  return verify(Buffer.concat(chunks, length), pin);
}
export async function prepareLegacyFixtures() {
  const cache = new URL('.test-fixtures/legacy/', root); await mkdir(cache, {recursive: true});
  for (const pin of manifest) {
    assert(['recipe-cards', 'longform'].includes(pin.appId));
    assert(/^[a-f0-9]{64}$/.test(pin.eventId) && /^[a-f0-9]{64}$/.test(pin.sha256));
    assert(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= 128 * 1024);
    const url = new URL(pin.url);
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'zencrown.relay2aeon.quest');
    assert.equal(url.port, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(url.href, url.origin + '/' + pin.sha256);
    const destination = new URL(pin.appId + '.html', cache);
    try {verify(await readFile(destination), pin); continue;} catch (error) {if (error.code !== 'ENOENT') throw error;}
    const source = process.env.HYPERGOLIC_LEGACY_FIXTURES;
    const bytes = source ? verify(await readFile(join(source, pin.eventId + '.html')), pin) : await download(pin);
    const temporary = fileURLToPath(destination) + '.' + process.pid + '.tmp';
    await writeFile(temporary, bytes); await rename(temporary, destination);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepareLegacyFixtures();
