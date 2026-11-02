import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../napplets/nap-support/', import.meta.url);
await build({configFile: false, root: root.pathname, build: {
  outDir: 'dist', emptyOutDir: true, minify: false, target: 'es2022', modulePreload: false,
  lib: {entry: new URL('src/main.ts', root).pathname, name: 'NapSupport', formats: ['iife'], fileName: () => 'support.js', cssFileName: 'support'},
}});
const js = (await readFile(new URL('dist/support.js', root), 'utf8')).replace(/<\/script/gi, '<\\/script');
const css = await readFile(new URL('dist/support.css', root), 'utf8');
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replace('</head>', `<style>${css}</style></head>`)
  .replace('<script type="module" src="./src/main.ts"></script>', `<script>${js}</script>`);
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = digest(html), aggregateHash = digest(`${sha256} /index.html\n`);
const manifest = {kind: 35129, created_at: 1791244800, tags: [
  ['d', 'nap-support'], ['path', '/index.html', sha256], ['x', aggregateHash, 'aggregate'], ['requires', 'link'],
], content: '', aggregateHash};
await mkdir(new URL('dist/', root), {recursive: true});
await writeFile(new URL('dist/index.html', root), html);
await writeFile(new URL('dist/manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
if (process.argv.includes('--stage-reviewed')) {
  await writeFile(new URL('../fixtures/nap-support.html', import.meta.url), html);
  await writeFile(new URL('../fixtures/nap-support-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify({sha256, aggregateHash, bytes: Buffer.byteLength(html)}, null, 2));
