import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Usage: pnpm run build:tester [--check | --help]

Build a signed standalone ARM64 tester APK on macOS or Linux.
Requires Node/pnpm and the Android/Java toolchain in docs/development.md.
Set HYPERGOLIC_KEYSTORE_PATH to an existing keystore outside the checkout.
Optional HYPERGOLIC_KEY_ALIAS selects a key in a multi-key keystore.
Set ANDROID_HOME (or ANDROID_SDK_ROOT); Build Tools 36.0.0 are required.
The signing tool prompts for passwords; do not put them in command arguments.
--check validates setup without building or signing.
Output: .tools/tester-apks/<version>-<versionCode>-<commit>-<unique>/
No upload, installation, key generation or automatic version increment occurs.
`;

export function verifyReleasePermissions(aaptOutput, applicationId) {
  const actual = [...aaptOutput.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)]
    .map(match => match[1]).sort();
  const expected = [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.INTERNET',
    'android.permission.USE_BIOMETRIC',
    'android.permission.USE_FINGERPRINT',
    `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
  ].sort();
  assert.deepEqual(actual, expected, 'Review changed Android Release permissions before tester packaging.');
}

function execute(command, args, { cwd, env, capture = false }) {
  const result = spawnSync(command, args, { cwd, env, shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed (${result.signal ?? result.status})`);
  return result.stdout ?? '';
}

export async function buildTester({ root = ROOT, env = process.env, args = process.argv.slice(2),
  run = execute, platform = process.platform } = {}) {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), HELP);
  assert(['darwin', 'linux'].includes(platform), 'Use macOS or Linux for build:tester.');
  root = await realpath(root);
  const app = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8')).expo;
  assert(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(app.version), 'Set a filename-safe expo.version in app.json.');
  assert(Number.isInteger(app.android.versionCode) && app.android.versionCode > 0 &&
    app.android.versionCode <= 2100000000, 'Set expo.android.versionCode to a positive release number in app.json.');
  assert(/^[a-zA-Z]\w*(\.[a-zA-Z]\w*)+$/.test(app.android.package), 'Invalid Android application ID.');
  assert(env.HYPERGOLIC_KEYSTORE_PATH, 'Set HYPERGOLIC_KEYSTORE_PATH to your existing signing keystore.');
  const key = await realpath(path.resolve(env.HYPERGOLIC_KEYSTORE_PATH));
  assert(key !== root && !key.startsWith(root + path.sep), 'Keep the signing keystore outside the checkout.');
  await access(key, constants.R_OK);
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  assert(sdk, 'Set ANDROID_HOME or ANDROID_SDK_ROOT to your Android SDK.');
  const tools = Object.fromEntries(['zipalign', 'apksigner', 'aapt'].map(name =>
    [name, path.resolve(sdk, 'build-tools', '36.0.0', name)]));
  for (const tool of Object.values(tools)) await access(tool, constants.X_OK);
  // Build children never need signing configuration or passwords.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('HYPERGOLIC_KEY')));
  const invoke = (command, argv, capture = false) => run(command, argv, { cwd: root, env: childEnv, capture });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(process.versions.node, manifest.engines.node, `Use Node ${manifest.engines.node}.`);
  const pnpmVersion = invoke('pnpm', ['--version'], true).trim();
  assert.equal(`pnpm@${pnpmVersion}`, manifest.packageManager, `Use ${manifest.packageManager}.`);
  invoke('java', ['-version']);
  const commit = invoke('git', ['rev-parse', 'HEAD'], true).trim();
  assert(/^[0-9a-f]{40}$/.test(commit), 'Cannot identify source commit.');
  const dirty = Boolean(invoke('git', ['status', '--porcelain'], true).trim());
  if (args[0] === '--check') { console.log('Tester APK prerequisites passed; no build or signing performed.'); return; }

  const outputRoot = path.join(root, '.tools', 'tester-apks');
  await mkdir(outputRoot, { recursive: true });
  const lock = path.join(outputRoot, '.build.lock');
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  let temporary;
  try {
    console.log('Building a development preview; this does not run the v1 acceptance gates.');
    invoke('pnpm', ['run', 'prebuild:android']);
    const unsigned = path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
    // Remove only this generated unsigned output so a stale APK cannot satisfy a failed build.
    await rm(unsigned, { force: true });
    invoke(path.join(root, 'android/gradlew'), ['-p', 'android', 'assembleRelease', '--no-daemon',
      '-PreactNativeArchitectures=arm64-v8a']);
    await access(unsigned, constants.R_OK);
    const metadata = invoke(tools.aapt, ['dump', 'badging', unsigned], true);
    assert(metadata.includes(`package: name='${app.android.package}' versionCode='${app.android.versionCode}' versionName='${app.version}'`),
      'Built APK identity/version differs from app.json.');
    assert(!metadata.includes('application-debuggable'), 'Refusing a debuggable APK.');
    assert(/^native-code: 'arm64-v8a'\s*$/m.test(metadata), 'Expected an ARM64 APK.');
    verifyReleasePermissions(invoke(tools.aapt, ['dump', 'permissions', unsigned], true), app.android.package);
    temporary = await mkdtemp(path.join(outputRoot, '.building-'));
    const aligned = path.join(temporary, 'aligned.apk');
    const filename = `hypergolic-${app.version}-${app.android.versionCode}-arm64.apk`;
    const apk = path.join(temporary, filename);
    invoke(tools.zipalign, ['-P', '16', '-f', '4', unsigned, aligned]);
    const signArgs = ['sign', '--ks', key];
    if (env.HYPERGOLIC_KEY_ALIAS) signArgs.push('--ks-key-alias', env.HYPERGOLIC_KEY_ALIAS);
    signArgs.push('--out', apk, aligned);
    invoke(tools.apksigner, signArgs);
    const verification = invoke(tools.apksigner, ['verify', '--verbose', '--print-certs', apk], true);
    const certificates = [...verification.matchAll(/certificate SHA-256 digest: ([0-9a-f:]+)/gi)].map(match => match[1]);
    assert(certificates.length > 0, 'No signing certificate fingerprint reported.');
    invoke(tools.zipalign, ['-c', '-P', '16', '4', apk]);
    const sha256 = createHash('sha256').update(await readFile(apk)).digest('hex');
    await writeFile(path.join(temporary, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
    await writeFile(path.join(temporary, 'build.json'), JSON.stringify({
      schemaVersion: 1, applicationId: app.android.package, version: app.version,
      versionCode: app.android.versionCode, architecture: 'arm64-v8a', sourceCommit: commit,
      sourceDirty: dirty, builtAt: new Date().toISOString(), apk: filename, sha256,
      signingCertificateSha256: certificates, acceptance: 'Development preview; native testing required',
    }, null, 2) + '\n');
    await rm(aligned);
    const destination = path.join(outputRoot, `${app.version}-${app.android.versionCode}-${commit.slice(0, 8)}-${path.basename(temporary).slice(10)}`);
    await rename(temporary, destination);
    temporary = undefined;
    console.log(`Verified tester APK: ${path.join(destination, filename)}\nChecksum and build receipt: ${destination}`);
    return destination;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTester().catch(error => { console.error(`Tester build failed: ${error.message}`); process.exitCode = 1; });
}
