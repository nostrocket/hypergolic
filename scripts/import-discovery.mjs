import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Pass the independent napplets workspace artifact explicitly; builds never fetch a feed.
const source = process.argv[2];
assert(source, 'Usage: node scripts/import-discovery.mjs <discovery/dist/index.html>');
const bytes = await readFile(resolve(source));
assert(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'Catalog exceeds the host artifact bound');
const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
assert(Buffer.from(html).equals(bytes));
assert(/^<!doctype html>\s*<html lang="en">\s*<head>/i.test(html));
assert(!/Content-Security-Policy|<base\b|<iframe\b|<script[^>]+src=/i.test(html));
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = digest(bytes);
const aggregateHash = digest(`${sha256} /index.html\n`);
const bundle = {title: 'Discover', appId: 'napplet-discovery', sha256, aggregateHash, domains: ['relay', 'resource', 'theme']};
const manifest = {kind: 35129, content: 'Find published Napplets and open them in your workspace.',
  tags: [['d', bundle.appId], ['title', bundle.title], ['path', '/index.html', sha256], ['x', aggregateHash, 'aggregate'], ['requires', 'relay'], ['requires', 'resource']], aggregateHash};
const root = new URL('../', import.meta.url);
await writeFile(new URL('runtime/fixtures/napplet-discovery.html', root), bytes);
await writeFile(new URL('runtime/fixtures/napplet-discovery-manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(new URL('src/runtime/discovery-bundle.ts', root), '/** Generated from the independently built catalog by scripts/import-discovery.mjs. */\nexport const DISCOVERY_BUNDLE = Object.freeze(' + JSON.stringify(bundle, null, 2).replace('"domains": [', '"domains": Object.freeze([').replace(/\n  \]\n}/, '\n  ])\n}') + ');\n');
console.log(JSON.stringify({sha256, aggregateHash, bytes: bytes.length}));
