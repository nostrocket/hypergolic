import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import assert from 'node:assert/strict';
import { BUNDLED_FIXTURES } from '../../src/runtime/bundled-catalog.ts';

const root = new URL('../', import.meta.url);
const bytes = await readFile(new URL('fixtures/ux-lab.html', root));
const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
assert(Buffer.from(html, 'utf8').equals(bytes), 'Fixture UTF-8 must round trip');
const lock = JSON.parse(await readFile(new URL('fixtures/lock.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('fixtures/ux-lab-manifest.json', root), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(bytes), lock.sha256, 'Fixture bytes changed: explicitly review and repin');
assert.equal(sha256(`${lock.sha256} /index.html\n`), lock.aggregateHash);
assert.equal(manifest.kind, 35129);
assert.equal(manifest.pubkey, undefined);
assert.equal(manifest.sig, undefined);
assert.deepEqual(manifest.tags.filter(t => t[0] === 'd'), [['d', lock.dTag]]);
assert.deepEqual(manifest.tags.filter(t => t[0] === 'path'), [['path', '/index.html', lock.sha256]]);
assert.deepEqual(manifest.tags.filter(t => t[0] === 'x'), [['x', lock.aggregateHash, 'aggregate']]);
assert.equal(manifest.aggregateHash, lock.aggregateHash);
assert.deepEqual(manifest.tags.filter(t => t[0] === 'requires'), []);
assert(/^<!doctype html>\s*<html lang="en">\s*<head>/i.test(html), 'Only reviewed generated fixture HTML is admitted');
assert.equal((html.match(/<head>/gi) ?? []).length, 1);
assert(!/Content-Security-Policy|<base\b|<iframe\b|<script[^>]+src=/i.test(html));
const fixtures = {};
for (const [name, reviewed] of Object.entries(BUNDLED_FIXTURES)) {
  const source = await readFile(new URL(`fixtures/${name}.html`, root));
  const content = new TextDecoder('utf-8', { fatal: true }).decode(source);
  assert(Buffer.from(content, 'utf8').equals(source));
  assert.equal(sha256(source), reviewed.sha256, `${name} bytes changed: review and repin`);
  assert.equal(sha256(`${reviewed.sha256} /index.html\n`), reviewed.aggregateHash);
  const record = JSON.parse(await readFile(new URL(`fixtures/${name}-manifest.json`, root), 'utf8'));
  assert.equal(record.kind, 35129);
  assert.equal(record.pubkey, undefined);
  assert.equal(record.sig, undefined);
  assert.deepEqual(record.tags.filter(t => t[0] === 'd'), [['d', reviewed.appId]]);
  assert.deepEqual(record.tags.filter(t => t[0] === 'path'), [['path', '/index.html', reviewed.sha256]]);
  assert.deepEqual(record.tags.filter(t => t[0] === 'x'), [['x', reviewed.aggregateHash, 'aggregate']]);
  assert.equal(record.aggregateHash, reviewed.aggregateHash);
  assert.deepEqual(record.tags.filter(t => t[0] === 'requires').map(t => t[1]).sort(), reviewed.domains.filter(d => d !== 'theme').sort());
  assert(/^<!doctype html>\s*<html lang="en">\s*<head>/i.test(content));
  assert.equal((content.match(/<head>/gi) ?? []).length, 1);
  assert(!/Content-Security-Policy|<base\b|<iframe\b|<script[^>]+src=/i.test(content));
  fixtures[name] = { ...reviewed, html: content };
}
const bundle = await build({
  configFile: false,
  root: root.pathname,
  define: {
    __BUNDLED_FIXTURES__: JSON.stringify(fixtures),
    __UX_HTML__: JSON.stringify(html),
    __UX_SHA256__: JSON.stringify(lock.sha256),
    __UX_AGGREGATE__: JSON.stringify(lock.aggregateHash),
  },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false,
    minify: true, modulePreload: false,
    lib: { entry: new URL('src/main.ts', root).pathname, name: 'HypergolicRuntime', formats: ['iife'], fileName: () => 'host.js' },
  },
});
const document = `<!doctype html>
<html lang="en"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; child-src 'self'; frame-src 'self'; media-src blob:; object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'">
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hypergolic runtime</title><script src="host.js" defer></script>
</head><body><p role="status">Loading napplet…</p></body></html>\n`;
await writeFile(new URL('dist/index.html', root), document);
const moduleIds = [...new Set((Array.isArray(bundle) ? bundle : [bundle]).flatMap(result =>
  result.output.flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : [])))];
const packages = new Map();
for (const id of moduleIds.filter(id => id.includes('/node_modules/'))) {
  let directory = dirname(id);
  while (directory.includes('/node_modules/')) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (!packages.has(metadata.name)) {
        let licenseText;
        for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
          try { licenseText = await readFile(join(directory, filename), 'utf8'); break; } catch { /* next filename */ }
        }
        packages.set(metadata.name, { name: metadata.name, version: metadata.version,
          license: metadata.license ?? 'unspecified', licenseText });
      }
      break;
    } catch { directory = dirname(directory); }
  }
}
const mit = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const bundledPackages = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const notices = bundledPackages.map(pkg => `${pkg.name}@${pkg.version} — ${pkg.license}\n\n${pkg.licenseText ?? (pkg.license === 'MIT' ? 'The published package declares MIT and includes no separate copyright notice.\n\n' + mit : 'The published package includes no license file.')}`).join('\n\n-----\n\n');
await writeFile(new URL('THIRD_PARTY_NOTICES.txt', root), notices + '\n');
const hostPath = new URL('dist/host.js', root);
await writeFile(hostPath, await readFile(hostPath, 'utf8') + '\n/*!\n' + notices.replaceAll('*/', '* /') + '\n*/\n');
assert(!/Math\.random\s*\(/.test(await readFile(hostPath, 'utf8')), 'Weak random fallback returned to the trusted runtime bundle');
const files = {};
for (const name of ['index.html', 'host.js']) {
  const value = await readFile(new URL(`dist/${name}`, root));
  files[name] = { sha256: sha256(value), bytes: value.byteLength };
}
await writeFile(new URL('assets-manifest.json', root), JSON.stringify({ schema: 1, fixture: lock, fixtures: BUNDLED_FIXTURES, bundledPackages: bundledPackages.map(({ name, version, license }) => ({ name, version, license })), assets: files }, null, 2) + '\n');
console.log(JSON.stringify({ fixture: lock, assets: files }, null, 2));
