import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'ios/Pods/libwebp');
const output = mkdtempSync(path.join(tmpdir(), 'hypergolic-webp-regression-'));
const binary = path.join(output, 'codec-regression');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = {scope: 'Host ASan/UBSan regression of installed CocoaPods source; physical iPhone decoding remains separate.', status: 'running', commands: []};

function run(command, args, name) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024});
  writeFileSync(path.join(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  receipt.commands.push({command, args, exitCode: result.status, signal: result.signal, error: result.error?.message});
  assert.equal(result.status, 0, `${name} failed; see ${output}`);
  return result.stdout;
}

try {
  assert.equal(process.platform, 'darwin', 'This regression uses the installed macOS/Xcode compiler.');
  const lock = readFileSync(path.join(root, 'ios/Podfile.lock'), 'utf8');
  assert.match(lock, /(?:^|\n)  - libwebp \(1\.6\.0\)/, 'Run iOS prebuild and pod install with the configured codec pin.');
  const directories = ['src/dec', 'src/enc', 'src/dsp', 'src/utils', 'sharpyuv'];
  const files = directories.flatMap(directory => readdirSync(path.join(source, directory))
    .filter(name => name.endsWith('.c')).map(name => path.join(source, directory, name))).sort();
  assert(files.length > 0, 'Installed WebP C sources are missing.');
  const observed = readdirSync(source, {recursive: true})
    .filter(name => /\.(?:c|h)$/.test(name)).sort();
  const inputHashes = Object.fromEntries(observed.map(name => [name, sha(readFileSync(path.join(source, name)))]));
  writeFileSync(path.join(output, 'source-inputs.json'), JSON.stringify(inputHashes, null, 2) + '\n');
  const compiler = run('xcrun', ['--sdk', 'macosx', '--find', 'clang'], 'compiler').trim();
  const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], 'sdk').trim();
  receipt.testSourceSha256 = sha(readFileSync(path.join(root, 'tests/native/codecs/webp-source-regression.c')));
  receipt.podLockSha256 = sha(Buffer.from(lock));
  run(compiler, ['-isysroot', sdk, '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', `-I${source}`,
    path.join(root, 'tests/native/codecs/webp-source-regression.c'), ...files, '-o', binary], 'compile');
  run(binary, [], 'regression');
  for (const name of observed) assert.equal(sha(readFileSync(path.join(source, name))), inputHashes[name], 'Codec source changed during the regression.');
  assert.equal(sha(readFileSync(path.join(root, 'tests/native/codecs/webp-source-regression.c'))), receipt.testSourceSha256, 'Regression source changed during execution.');
  assert.equal(sha(readFileSync(path.join(root, 'ios/Podfile.lock'))), receipt.podLockSha256, 'Pod lock changed during execution.');
  receipt.sourceCAndHeaderFiles = observed.length;
  receipt.sourceCFiles = files.length;
  receipt.sourceUnchanged = true;
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  rmSync(binary, {force: true});
  rmSync(`${binary}.dSYM`, {recursive: true, force: true});
  receipt.compiledTestBinaryRemoved = true;
  receipt.debugSymbolsRemoved = true;
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({status: receipt.status, evidenceDirectory: output, error: receipt.error}));
}
