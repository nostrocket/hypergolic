import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'ios/Pods/libdav1d');
const output = mkdtempSync(path.join(tmpdir(), 'hypergolic-dav1d-regression-'));
const binary = path.join(output, 'tile-regression');
const sha = value => createHash('sha256').update(value).digest('hex');
const receipt = {status: 'running', scope: 'Actual installed decoder loop extracted with real owning structures; host arithmetic sanitizer subset, not full-bitstream or physical acceptance.', commands: []};
function run(command, args, name) {
  const p = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 60_000});
  writeFileSync(path.join(output, `${name}.log`), (p.stdout ?? '') + (p.stderr ?? ''));
  receipt.commands.push({command, args, exitCode: p.status, signal: p.signal, error: p.error?.message});
  assert.equal(p.status, 0, `${name} failed; see ${output}`);
  return p.stdout.trim();
}
try {
  assert.equal(process.platform, 'darwin', 'This regression needs the macOS/Xcode compiler.');
  const manifest = JSON.parse(readFileSync(path.join(root, 'plugins/native-codec-patches.json'), 'utf8'));
  for (const entry of manifest.files) {
    assert.equal(sha(readFileSync(path.join(root, 'ios/Pods', entry.path))), entry.afterSha256, 'Install the pinned, patched iOS Pod sources first.');
  }
  const code = readFileSync(path.join(source, 'dav1d/src/decode.c'), 'utf8');
  const start = code.indexOf('    if (c->n_fc > 1) {', code.indexOf('const int num_sb128'));
  const end = code.indexOf('\n\n        const int lowest_pixel_mem_sz', start);
  assert(start >= 0 && end > start, 'Owning loop boundaries changed; review the regression scope.');
  const harness = readFileSync(path.join(root, 'tests/native/codecs/dav1d-tile-offsets.c'), 'utf8');
  const loop = code.slice(start, end) + '\n    }';
  const generated = harness.replace('/* HYPERGOLIC_OWNING_TILE_LOOP */', loop);
  const generatedPath = path.join(output, 'actual-owning-loop.c');
  writeFileSync(generatedPath, generated);
  receipt.decoderSourceSha256 = sha(Buffer.from(code));
  receipt.harnessSha256 = sha(Buffer.from(harness));
  receipt.generatedSourceSha256 = sha(Buffer.from(generated));
  const compiler = run('xcrun', ['--sdk', 'macosx', '--find', 'clang'], 'compiler');
  const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], 'sdk');
  run(compiler, ['-isysroot', sdk, '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
    '-fno-omit-frame-pointer', `-I${source}/dav1d`, `-I${source}/dav1d/include`, `-I${source}/generate`, generatedPath, '-o', binary], 'compile');
  run(binary, [], 'regression');
  for (const entry of manifest.files) assert.equal(sha(readFileSync(path.join(root, 'ios/Pods', entry.path))), entry.afterSha256, 'Native source changed during execution.');
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1;
} finally {
  rmSync(binary, {force: true});
  rmSync(`${binary}.dSYM`, {recursive: true, force: true});
  receipt.binaryAndDebugSymbolsRemoved = true;
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({status: receipt.status, evidenceDirectory: output, error: receipt.error}));
}
