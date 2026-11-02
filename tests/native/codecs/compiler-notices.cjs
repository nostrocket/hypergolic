'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { verify } = require('../../../modules/napplet-host/android/CompilerDependencyNotices.cjs');
const source = path.resolve(__dirname, '../../../modules/napplet-host/android/src/main/assets/compiler-notices');

function fixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hypergolic-compiler-notices-'));
  const directory = path.join(temporary, 'notices');
  fs.cpSync(source, directory, { recursive: true });
  try {
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    // Disposable compiler bytes exercise identity drift; real Gradle capture is verified separately.
    const file = path.join(temporary, manifest.compiler.filename);
    fs.writeFileSync(file, 'reviewed compiler fixture');
    manifest.compiler.bytes = fs.statSync(file).size;
    manifest.compiler.sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const compiler = { component: manifest.compiler.component, file, d8CodeSource: pathToFileURL(file).href,
      embeddedD8Version: manifest.compiler.embeddedD8Version, upstreamCommit: manifest.compiler.upstreamCommit };
    run(directory, compiler, manifest);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function changeManifest(directory, edit) {
  const file = path.join(directory, 'manifest.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); edit(data); fs.writeFileSync(file, JSON.stringify(data));
}
test('exact original and unchanged selected compiler pass repeatedly', () => fixture((directory, compiler) => {
  verify(directory, compiler); verify(directory, compiler);
}));
test('changed compiler coordinate rejects', () => fixture((directory, compiler) => {
  compiler.component = 'com.android.tools.build:builder:8.13.0';
  assert.throws(() => verify(directory, compiler), /selected compiler changed/);
}));
test('changed D8 embedded version rejects', () => fixture((directory, compiler) => {
  compiler.embeddedD8Version = '8.13.0'; assert.throws(() => verify(directory, compiler), /selected compiler changed/);
}));
test('changed embedded compiler commit rejects', () => fixture((directory, compiler) => {
  compiler.upstreamCommit = '0'.repeat(40); assert.throws(() => verify(directory, compiler), /selected compiler changed/);
}));
test('changed D8 class-loader origin rejects', () => fixture((directory, compiler) => {
  compiler.d8CodeSource = pathToFileURL(path.join(path.dirname(compiler.file), 'other.jar')).href;
  assert.throws(() => verify(directory, compiler), /class-loader origin/);
}));
test('remote D8 origin rejects without a request', () => fixture((directory, compiler) => {
  compiler.d8CodeSource = 'https://example.invalid/compiler.jar';
  assert.throws(() => verify(directory, compiler), /class-loader origin/);
}));
test('relative compiler path rejects', () => fixture((directory, compiler) => {
  compiler.file = path.basename(compiler.file); assert.throws(() => verify(directory, compiler), /selected compiler changed/);
}));
test('missing selected compiler rejects', () => fixture(directory => {
  assert.throws(() => verify(directory, null), /selected compiler changed/);
}));
test('same coordinate and filename with changed archive bytes rejects', () => fixture((directory, compiler) => {
  const bytes = fs.readFileSync(compiler.file); bytes[0] ^= 1; fs.writeFileSync(compiler.file, bytes);
  assert.throws(() => verify(directory, compiler), /archive bytes changed/);
}));
test('changed archive size rejects', () => fixture((directory, compiler) => {
  fs.appendFileSync(compiler.file, '!'); assert.throws(() => verify(directory, compiler), /archive bytes changed/);
}));
test('changed original BSD text rejects', () => fixture((directory, compiler, manifest) => {
  const file = path.join(directory, manifest.original.file); const bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, compiler), /original bytes changed/);
}));
test('missing original rejects', () => fixture((directory, compiler, manifest) => {
  fs.unlinkSync(path.join(directory, manifest.original.file)); assert.throws(() => verify(directory, compiler), /file set changed/);
}));
test('extra notice file rejects', () => fixture((directory, compiler) => {
  fs.writeFileSync(path.join(directory, 'extra.txt'), 'unreviewed'); assert.throws(() => verify(directory, compiler), /file set changed/);
}));
test('unsafe original path rejects', () => fixture((directory, compiler) => {
  changeManifest(directory, data => { data.original.file = '../outside.txt'; });
  assert.throws(() => verify(directory, compiler), /Unsafe or incomplete/);
}));
test('changed original Git blob rejects', () => fixture((directory, compiler) => {
  changeManifest(directory, data => { data.original.gitBlob = '0'.repeat(40); });
  assert.throws(() => verify(directory, compiler), /original bytes changed/);
}));
test('changed immutable source revision rejects', () => fixture((directory, compiler) => {
  changeManifest(directory, data => { data.original.source = data.original.source.replace(data.compiler.upstreamCommit, '0'.repeat(40)); });
  assert.throws(() => verify(directory, compiler), /immutable source binding changed/);
}));
test('wrong platform or scope rejects', () => fixture((directory, compiler) => {
  changeManifest(directory, data => { data.platform = 'ios'; });
  assert.throws(() => verify(directory, compiler), /Unexpected Android compiler notice manifest/);
}));
