import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const result = spawnSync('pnpm', ['--dir', 'runtime', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const manifestBytes = await readFile(new URL('runtime/assets-manifest.json', root));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.deepEqual(Object.keys(manifest.assets).sort(), ['host.js', 'index.html']);
const androidDestination = new URL('modules/napplet-host/android/src/main/assets/runtime/', root);
const iosDestination = new URL('modules/napplet-host/ios/Resources/runtime/', root);
await Promise.all([androidDestination, iosDestination].map(directory => mkdir(directory, { recursive: true })));
for (const name of ['index.html', 'host.js']) {
  const bytes = await readFile(new URL(`runtime/dist/${name}`, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.assets[name].sha256);
  assert.equal(bytes.byteLength, manifest.assets[name].bytes);
  await Promise.all([androidDestination, iosDestination].map(directory => writeFile(new URL(name, directory), bytes)));
}
await writeFile(new URL('assets-manifest.json', iosDestination), manifestBytes);
console.log('Verified identical trusted runtime assets copied for Android and iOS.');

await import('./build-fixture-release.mjs');
