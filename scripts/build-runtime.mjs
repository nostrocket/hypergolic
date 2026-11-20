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
const expected = JSON.parse(await readFile(new URL('config/runtime-assets.json', root)))[manifest.variant];
assert(expected, 'Unrecognized embedded runtime variant');
await import('./build-fixture-release.mjs');
const generated = {
  'host.js': new URL('runtime/dist/host.js', root),
  'index.html': new URL('runtime/dist/index.html', root),
  'fixture-release.json': new URL('runtime/.fixture-release.json', root),
};
const android = 'modules/napplet-host/android/src/main/assets/runtime/';
const ios = 'modules/napplet-host/ios/Resources/runtime/';
const checkIos = process.argv.includes('--check-ios');
const destinations = checkIos ? [ios] : process.argv.includes('--android') ? [android] : [android, ios];
for (const destination of destinations) {
  const directory = new URL(destination, root);
  if (!checkIos) await mkdir(directory, {recursive: true});
  for (const [name, source] of Object.entries(generated)) {
    const bytes = await readFile(source);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, expected[name], `Review the source and update the ${manifest.variant} pin for ${name}`);
    if (name in manifest.assets) assert.deepEqual(manifest.assets[name], {sha256: digest, bytes: bytes.length});
    const target = new URL(name, directory);
    if (checkIos) assert(bytes.equals(await readFile(target)), `Stale iOS ${name}. Run pnpm runtime:build.`);
    else await writeFile(target, bytes);
  }
  if (destination === ios) {
    const target = new URL('assets-manifest.json', directory);
    if (checkIos) assert(manifestBytes.equals(await readFile(target)), 'Stale iOS runtime manifest. Run pnpm runtime:build.');
    else await writeFile(target, manifestBytes);
  }
}
console.log(`Verified reviewed ${manifest.variant} runtime assets.`);
