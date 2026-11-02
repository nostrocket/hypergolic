import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {BUNDLED_FIXTURES} from '../src/runtime/bundled-catalog.ts';
const root = new URL('../', import.meta.url), artifacts = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [id, expected] of Object.entries(BUNDLED_FIXTURES)) {
  if (id === 'nap-support' || id === 'approval-lab-v1' || id === 'approval-lab-v2' || id === 'approval-lab-v3' || id === 'feed-lab-v1') continue;
  const bytes = await readFile(new URL(`runtime/fixtures/${id}.html`, root));
  const html = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const manifest = JSON.parse(await readFile(new URL(`runtime/fixtures/${id}-manifest.json`, root)));
  assert.equal(hash(bytes), expected.sha256);
  assert.equal(hash(`${expected.sha256} /index.html\n`), expected.aggregateHash);
  assert(Buffer.from(html).equals(bytes));
  assert.equal(manifest.kind, 35129);
  assert.equal(manifest.pubkey, undefined); assert.equal(manifest.sig, undefined);
  artifacts[id] = {html, sha256: expected.sha256, aggregate: expected.aggregateHash, tags: manifest.tags};
}
const routing = artifacts['routing-lab'];
artifacts['routing-lab-peer'] = {...routing, tags: routing.tags.map(tag => tag[0] === 'd' ? ['d','routing-lab-peer'] : tag).concat([['archetype','note','napplet:note/open']])};
const bytes = Buffer.from(JSON.stringify({schema: 1, artifacts}));
assert(bytes.length < 1024 * 1024);
for (const destination of ['modules/napplet-host/android/src/main/assets/runtime/fixture-release.json','modules/napplet-host/ios/Resources/runtime/fixture-release.json']) {
  await writeFile(new URL(destination, root), bytes);
}
console.log(`Sealed ${Object.keys(artifacts).length} trusted fixture release artifacts: ${hash(bytes)}`);
