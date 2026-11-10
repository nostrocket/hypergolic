import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleasePermissions } from './build-tester.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

export function command(commandName, args, { root, env, capture = false }) {
  const result = spawnSync(commandName, args, { cwd: root, env, shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(commandName)} failed (${result.signal ?? result.status}).`);
  return result.stdout ?? '';
}

/** Build tools never receive release credentials or repository write tokens. */
export function buildEnvironment(env) {
  const names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'JAVA_HOME', 'ANDROID_HOME',
    'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'PNPM_HOME', 'LANG', 'LC_ALL', 'CI'];
  return { ...Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    HYPERGOLIC_VARIANT: 'production', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1' };
}

export async function releaseConfig(root) {
  const app = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8')).expo;
  const policy = JSON.parse(await readFile(path.join(root, 'config/android-release.json'), 'utf8'));
  assert.equal(policy.applicationId, 'space.hypergolic', 'Unexpected production application ID.');
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(app.version), 'Invalid release version.');
  assert(Number.isInteger(app.android.versionCode) && app.android.versionCode > 0 &&
    app.android.versionCode <= 2100000000, 'Invalid Android versionCode.');
  return { applicationId: policy.applicationId, version: app.version, versionCode: app.android.versionCode,
    signingCertificateSha256: policy.signingCertificateSha256 };
}

function sourceCommit(invoke) {
  assert.equal(invoke('git', ['status', '--porcelain'], true).trim(), '', 'Release requires a clean, committed source tree.');
  const commit = invoke('git', ['rev-parse', 'HEAD'], true).trim();
  assert(/^[a-f0-9]{40}$/.test(commit), 'Cannot identify the release source commit.');
  return commit;
}

function tools(env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  assert(sdk, 'Set ANDROID_HOME to the Android SDK.');
  return Object.fromEntries(['aapt', 'apksigner', 'zipalign'].map(name =>
    [name, path.resolve(sdk, 'build-tools/36.0.0', name)]));
}

export function verifyApkMetadata(metadata, manifest, config) {
  assert(metadata.includes(`package: name='${config.applicationId}' versionCode='${config.versionCode}' versionName='${config.version}'`),
    'APK identity/version does not match the release configuration.');
  assert(!metadata.includes('application-debuggable'), 'Refusing a debuggable APK.');
  assert(/^native-code: 'arm64-v8a'\s*$/m.test(metadata), 'Expected an ARM64-only APK.');
  for (const line of manifest.split('\n').filter(line => /android:(debuggable|testOnly)\b/.test(line))) {
    assert(/\(type 0x12\)0x0\s*$/.test(line), 'Refusing a debug/test-only APK.');
  }
}

export function verifyCertificate(output, expected) {
  assert(typeof expected === 'string' && /^[a-f0-9]{64}$/i.test(expected),
    'Set signingCertificateSha256 in config/android-release.json to the production certificate fingerprint.');
  const certificates = [...output.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-f0-9:]+)/gi)]
    .map(match => match[1].replaceAll(':', '').toLowerCase());
  assert.deepEqual(certificates, [expected.toLowerCase()], 'APK was signed by an unexpected certificate.');
}

function inspectApk(apk, config, sdk, invoke) {
  const metadata = invoke(sdk.aapt, ['dump', 'badging', apk], true);
  verifyApkMetadata(metadata, invoke(sdk.aapt, ['dump', 'xmltree', apk, 'AndroidManifest.xml'], true), config);
  verifyReleasePermissions(invoke(sdk.aapt, ['dump', 'permissions', apk], true), config.applicationId);
  invoke('python3', ['scripts/verify-release-apk.py', apk, config.version, String(config.versionCode)]);
}

async function transaction(destination, operation) {
  destination = path.resolve(destination);
  await assert.rejects(access(destination), { code: 'ENOENT' }, 'Output already exists; use a new candidate directory.');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.android-release-'));
  try { await operation(temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { recursive: true, force: true }); }
  return destination;
}

export async function buildRelease({ root = ROOT, env = process.env, output, run = command } = {}) {
  assert(output, 'Usage: pnpm run build:release <new-output-directory>');
  root = await realpath(root);
  const cleanEnv = buildEnvironment(env);
  const invoke = (name, args, capture = false) => run(name, args, { root, env: cleanEnv, capture });
  const config = await releaseConfig(root);
  const commit = sourceCommit(invoke);
  const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageInfo.version, config.version, 'package.json and app.json versions must match.');
  assert.equal(process.versions.node, packageInfo.engines.node, 'Use the pinned Node version.');
  assert.equal(`pnpm@${invoke('pnpm', ['--version'], true).trim()}`, packageInfo.packageManager, 'Use the pinned pnpm version.');
  const resolved = JSON.parse(invoke('pnpm', ['exec', 'expo', 'config', '--type', 'public', '--json'], true));
  assert.equal(resolved.android.package, config.applicationId, 'Expo did not select production.');
  assert.equal(resolved.extra.hypergolic.variant, 'production', 'Developer tooling must be disabled.');
  const sdk = tools(cleanEnv);
  const lock = path.join(root, '.tools/tester-apks/.build.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
  try {
    return await transaction(output, async directory => {
      invoke('pnpm', ['run', 'prebuild:android']);
      const unsigned = path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
      await rm(unsigned, { force: true });
      invoke(path.join(root, 'android/gradlew'), ['-p', 'android', 'assembleRelease', '--no-daemon', '-PreactNativeArchitectures=arm64-v8a']);
      inspectApk(unsigned, config, sdk, invoke);
      assert.equal(sourceCommit(invoke), commit, 'Build changed the reviewed source.');
      await copyFile(unsigned, path.join(directory, 'unsigned.apk'));
      await writeFile(path.join(directory, 'input.json'), JSON.stringify({ schemaVersion: 1,
        applicationId: config.applicationId, version: config.version, versionCode: config.versionCode,
        sourceCommit: commit, unsignedSha256: sha256(await readFile(unsigned)) }, null, 2) + '\n');
    });
  } finally { await rm(lock, { force: true }); }
}

export async function signRelease({ root = ROOT, env = process.env, input, output, run = command } = {}) {
  assert(input && output, 'Usage: pnpm run sign:release <unsigned-directory> <new-output-directory>');
  root = await realpath(root);
  const cleanEnv = buildEnvironment(env);
  const invoke = (name, args, capture = false) => run(name, args, { root, env: cleanEnv, capture });
  const config = await releaseConfig(root);
  const commit = sourceCommit(invoke);
  const receipt = JSON.parse(await readFile(path.join(input, 'input.json'), 'utf8'));
  const unsigned = path.resolve(input, 'unsigned.apk');
  assert.deepEqual(receipt, { schemaVersion: 1, applicationId: config.applicationId, version: config.version,
    versionCode: config.versionCode, sourceCommit: commit, unsignedSha256: sha256(await readFile(unsigned)) },
  'Unsigned artifact does not match the checked-out source and release metadata.');
  assert(/^[a-f0-9]{64}$/i.test(config.signingCertificateSha256 ?? ''),
    'Register the production certificate in config/android-release.json before signing.');
  for (const name of ['HYPERGOLIC_KEYSTORE_PATH', 'HYPERGOLIC_KEY_ALIAS', 'HYPERGOLIC_KEYSTORE_PASSWORD', 'HYPERGOLIC_KEY_PASSWORD']) {
    assert(env[name], `Set ${name} for release signing.`);
  }
  const key = await realpath(env.HYPERGOLIC_KEYSTORE_PATH);
  assert(!inside(root, key), 'Keep the production keystore outside the source checkout.');
  const sdk = tools(cleanEnv);
  inspectApk(unsigned, config, sdk, invoke);
  return transaction(output, async directory => {
    const filename = `hypergolic-${config.version}-${config.versionCode}-arm64.apk`;
    const apk = path.join(directory, filename);
    const aligned = path.join(directory, 'aligned.apk');
    invoke(sdk.zipalign, ['-P', '16', '-f', '4', unsigned, aligned]);
    run(sdk.apksigner, ['sign', '--ks', key, '--ks-key-alias', env.HYPERGOLIC_KEY_ALIAS,
      '--ks-pass', 'env:HYPERGOLIC_KEYSTORE_PASSWORD', '--key-pass', 'env:HYPERGOLIC_KEY_PASSWORD', '--out', apk, aligned],
    { root, env: { ...cleanEnv, HYPERGOLIC_KEYSTORE_PASSWORD: env.HYPERGOLIC_KEYSTORE_PASSWORD,
      HYPERGOLIC_KEY_PASSWORD: env.HYPERGOLIC_KEY_PASSWORD } });
    verifyCertificate(invoke(sdk.apksigner, ['verify', '--verbose', '--print-certs', apk], true), config.signingCertificateSha256);
    invoke(sdk.zipalign, ['-c', '-P', '16', '4', apk]);
    inspectApk(apk, config, sdk, invoke);
    const hash = sha256(await readFile(apk));
    await writeFile(path.join(directory, 'SHA256SUMS'), `${hash}  ${filename}\n`);
    await writeFile(path.join(directory, 'build.json'), JSON.stringify({ ...receipt, architecture: 'arm64-v8a',
      apk: filename, sha256: hash, signingCertificateSha256: config.signingCertificateSha256.toLowerCase(),
      acceptance: 'Candidate; standalone Android acceptance required' }, null, 2) + '\n');
    await rm(aligned);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, first, second, ...extra] = process.argv.slice(2);
  const main = async () => {
    assert(extra.length === 0 && ((mode === 'build' && first && !second) || (mode === 'sign' && first && second)),
      'Usage: android-release.mjs build OUTPUT | sign INPUT OUTPUT');
    const result = mode === 'build' ? await buildRelease({ output: first }) : await signRelease({ input: first, output: second });
    console.log(`Verified ${mode === 'build' ? 'unsigned input' : 'signed candidate'}: ${result}`);
  };
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
