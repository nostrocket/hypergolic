import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, realpath } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTester, verifyReleasePermissions } from '../../scripts/build-tester.mjs';

async function fixture(t, failure) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'tester-build-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source with spaces');
  const sdk = path.join(base, 'sdk with spaces');
  await mkdir(root);
  await mkdir(path.join(sdk, 'build-tools/36.0.0'), { recursive: true });
  for (const name of ['aapt', 'zipalign', 'apksigner']) await writeFile(path.join(sdk, 'build-tools/36.0.0', name), '', { mode: 0o755 });
  const key = path.join(base, 'key with spaces.jks');
  await writeFile(key, 'fixture only');
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo: { version: '0.0.1', android: { package: 'org.example.tester', versionCode: 2 } } }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.34.5' }));
  const unsigned = path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
  await mkdir(path.dirname(unsigned), { recursive: true });
  await writeFile(unsigned, 'stale');
  const calls = [];
  const run = (command, args, options) => {
    const name = path.basename(command);
    calls.push([name, ...args]);
    assert(!Object.keys(options.env).some(key => key.startsWith('HYPERGOLIC_KEY')));
    if (name === 'pnpm' && args[0] === '--version') return '10.34.5\n';
    if (name === 'git') return args[0] === 'rev-parse' ? 'a'.repeat(40) : ' M README.md';
    if (name === 'gradlew') {
      assert(!existsSync(unsigned), 'Stale output must be removed before Gradle');
      if (failure === 'build') throw new Error('gradle failed');
      if (failure !== 'missing') writeFileSync(unsigned, 'fresh unsigned');
    }
    if (name === 'aapt' && args[1] === 'permissions') return `package: org.example.tester\nuses-permission: name='android.permission.INTERNET'\nuses-permission: name='android.permission.USE_BIOMETRIC'\nuses-permission: name='android.permission.ACCESS_NETWORK_STATE'\nuses-permission: name='android.permission.USE_FINGERPRINT'\nuses-permission: name='org.example.tester.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'\n${failure === 'permission' ? "uses-permission: name='android.permission.VIBRATE'" : ''}`;
    if (name === 'aapt') return `package: name='org.example.tester' versionCode='${failure === 'version' ? 1 : 2}' versionName='0.0.1'\nnative-code: 'arm64-v8a'\n${failure === 'debug' ? 'application-debuggable' : ''}`;
    if (name === 'zipalign' && args[0] !== '-c') writeFileSync(args.at(-1), 'aligned');
    if (name === 'apksigner' && args[0] === 'sign') {
      assert.equal(args[2], key);
      if (failure === 'sign') throw new Error('signing cancelled');
      writeFileSync(args[args.indexOf('--out') + 1], 'signed fixture');
    }
    if (name === 'apksigner' && args[0] === 'verify') {
      if (failure === 'verify') throw new Error('bad signature');
      return 'Signer #1 certificate SHA-256 digest: ' + 'b'.repeat(64);
    }
    return '';
  };
  return { root, env: { ANDROID_HOME: sdk, HYPERGOLIC_KEYSTORE_PATH: key, HYPERGOLIC_KEY_PASSWORD: 'must-not-leak' }, args: [], platform: 'darwin', run, calls };
}

test('Packages verified APKs without credentials, supports spaced paths and preserves older outputs', async t => {
  const f = await fixture(t);
  const first = await buildTester(f);
  const second = await buildTester(f);
  assert.notEqual(first, second);
  const receipt = JSON.parse(await readFile(path.join(first, 'build.json')));
  assert.equal(receipt.sourceDirty, true);
  assert.equal(receipt.versionCode, 2);
  assert.equal(receipt.signingCertificateSha256[0], 'b'.repeat(64));
  assert.match(await readFile(path.join(first, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  hypergolic-0.0.1-2-arm64.apk\n$/);
  assert(!(await readFile(path.join(first, 'build.json'), 'utf8')).includes('key with spaces'));
  assert(!(await readdir(first)).includes('aligned.apk'));
  assert(f.calls.findIndex(c => c[0] === 'zipalign') < f.calls.findIndex(c => c[0] === 'apksigner'));
});
for (const failure of ['build', 'missing', 'version', 'debug', 'permission', 'sign', 'verify']) {
  test(`No successful output after ${failure} failure`, async t => {
    const f = await fixture(t, failure);
    await assert.rejects(buildTester(f));
    assert.deepEqual(await readdir(path.join(f.root, '.tools/tester-apks')), []);
  });
}
test('Preflight performs no build or signing', async t => {
  const f = await fixture(t);
  await buildTester({ ...f, args: ['--check'] });
  assert(!f.calls.some(c => ['gradlew', 'apksigner'].includes(c[0])));
  assert(!existsSync(path.join(f.root, '.tools')));
});
test('Missing signing configuration stops before build', async t => {
  const f = await fixture(t); delete f.env.HYPERGOLIC_KEYSTORE_PATH;
  await assert.rejects(buildTester(f), /HYPERGOLIC_KEYSTORE_PATH/);
  assert.equal(f.calls.length, 0);
});
test('An existing build lock and its artifacts remain untouched', async t => {
  const f = await fixture(t);
  const output = path.join(f.root, '.tools/tester-apks'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, '.build.lock'), 'another process');
  await assert.rejects(buildTester(f), /EEXIST/);
  assert.equal(await readFile(path.join(output, '.build.lock'), 'utf8'), 'another process');
});

test('Final permission verifier rejects even a version-scoped unexpected request', () => {
  const output = "uses-permission: name='android.permission.INTERNET'\n" +
    "uses-permission: name='android.permission.USE_BIOMETRIC'\n" +
    "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'\n" +
    "uses-permission: name='android.permission.USE_FINGERPRINT'\n" +
    "uses-permission: name='org.example.tester.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'\n" +
    "uses-permission-sdk-23: name='android.permission.READ_EXTERNAL_STORAGE'\n";
  assert.throws(() => verifyReleasePermissions(output, 'org.example.tester'), /Review changed Android Release permissions/);
});
