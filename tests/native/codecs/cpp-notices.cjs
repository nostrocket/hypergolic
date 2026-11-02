'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const { verify } = require('../../../modules/napplet-host/android/CppDependencyNotices.cjs');
const source = path.join(root, 'modules/napplet-host/android/src/main/assets/cpp-notices');
const rootNotices = path.join(root, 'modules/napplet-host/android/src/main/assets/notices');
const ndk = process.env.HYPERGOLIC_NOTICE_NDK || path.join(root, '.tools/android-sdk/ndk/27.1.12297006');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
function fixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hypergolic-cpp-notices-'));
  const directory = path.join(temporary, 'notices');
  fs.cpSync(source, directory, { recursive: true });
  try { run(directory, temporary); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function editManifest(directory, edit) {
  const file = path.join(directory, 'manifest.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); edit(data); fs.writeFileSync(file, JSON.stringify(data));
}
function fixtureNdk(temporary) {
  const copy = path.join(temporary, 'ndk');
  for (const name of new Set(['source.properties', 'NOTICE.toolchain', ...Object.keys(manifest.ndkProfile.inputs), ...Object.keys(manifest.ndkProfile.compilerHeaders)])) {
    const destination = path.join(copy, name); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ndk, name), destination);
  }
  return copy;
}
test('actual reviewed NDK originals, headers and package roots pass', () => verify(source, ndk, rootNotices));
test('same-length edited original fails', () => fixture(directory => {
  const file = path.join(directory, manifest.originals[0].file); const bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, ndk, rootNotices), /original bytes changed/);
}));
test('omitted credits fail', () => fixture(directory => {
  fs.unlinkSync(path.join(directory, manifest.noticeBindings[0].creditsFile));
  assert.throws(() => verify(directory, ndk, rootNotices), /file set changed/);
}));
test('changed NDK revision fails before review reuse', () => fixture((directory, temporary) => {
  const copy = fixtureNdk(temporary); fs.writeFileSync(path.join(copy, 'source.properties'), 'Pkg.Revision = 28.0.0\n');
  assert.throws(() => verify(directory, copy, rootNotices), /NDK version changed/);
}));
test('edited compiled C++ header fails', () => fixture((directory, temporary) => {
  const copy = fixtureNdk(temporary); const first = Object.keys(manifest.ndkProfile.compilerHeaders)[0];
  fs.appendFileSync(path.join(copy, first), '\nchanged');
  assert.throws(() => verify(directory, copy, rootNotices), /reviewed NDK input changed/);
}));
test('edited C++ runtime fails', () => fixture((directory, temporary) => {
  const copy = fixtureNdk(temporary); const library = Object.keys(manifest.ndkProfile.inputs).find(name => name.endsWith('.so'));
  fs.appendFileSync(path.join(copy, library), 'changed');
  assert.throws(() => verify(directory, copy, rootNotices), /reviewed NDK input changed/);
}));
test('wrong original aggregate range fails', () => fixture(directory => {
  editManifest(directory, data => { data.noticeBindings[0].aggregateByteStart += 1; });
  assert.throws(() => verify(directory, ndk, rootNotices), /aggregate binding changed/);
}));
test('unsafe NDK input fails before outside file access', () => fixture(directory => {
  editManifest(directory, data => { data.ndkProfile.compilerHeaders = { '../outside': 'irrelevant' }; });
  assert.throws(() => verify(directory, ndk, rootNotices), /Unsafe Android C\+\+ notice input/);
}));

test('complete official aggregate originals cannot be changed', () => fixture(directory => {
  const file = path.join(directory, manifest.aggregateOriginals[0].file); const bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, ndk, rootNotices), /original bytes changed/);
}));
test('missing complete aggregate original rejects', () => fixture(directory => {
  fs.unlinkSync(path.join(directory, manifest.aggregateOriginals[1].file));
  assert.throws(() => verify(directory, ndk, rootNotices), /file set changed/);
}));
test('aggregate originals cannot be assigned to the wrong source', () => fixture(directory => {
  editManifest(directory, data => { data.aggregateOriginals[0].file = data.aggregateOriginals[1].file; });
  assert.throws(() => verify(directory, ndk, rootNotices), /complete aggregate original binding changed/);
}));
test('omitted aggregate source binding rejects', () => fixture(directory => {
  editManifest(directory, data => { data.aggregateOriginals.pop(); });
  assert.throws(() => verify(directory, ndk, rootNotices), /aggregate original set changed/);
}));
test('edited actual system compiler header rejects', () => fixture((directory, temporary) => {
  const copy = fixtureNdk(temporary);
  const first = Object.keys(manifest.ndkProfile.compilerHeaders).find(name => name.endsWith('/sysroot/usr/include/features.h'));
  const file = path.join(copy, first); const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, copy, rootNotices), /reviewed NDK input changed/);
}));
test('edited actual Clang compiler header rejects', () => fixture((directory, temporary) => {
  const copy = fixtureNdk(temporary);
  const first = Object.keys(manifest.ndkProfile.compilerHeaders).find(name => name.includes('/lib/clang/18/include/'));
  const file = path.join(copy, first); const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, copy, rootNotices), /reviewed NDK input changed/);
}));
test('omitted compiled system header rejects', () => fixture(directory => {
  editManifest(directory, data => {
    const first = Object.keys(data.ndkProfile.compilerHeaders).find(name => name.endsWith('/sysroot/usr/include/features.h'));
    delete data.ndkProfile.compilerHeaders[first];
  });
  assert.throws(() => verify(directory, ndk, rootNotices), /reviewed header counts changed/);
}));
test('unreviewed header family rejects', () => fixture(directory => {
  editManifest(directory, data => { data.ndkProfile.compilerHeaders['NOTICE.toolchain'] = data.ndkProfile.inputs['NOTICE.toolchain']; });
  assert.throws(() => verify(directory, ndk, rootNotices), /Unexpected Android NDK compiled header family/);
}));
test('header count metadata order does not change semantics', () => fixture(directory => {
  editManifest(directory, data => {
    const counts = data.ndkProfile.headerReview;
    data.ndkProfile.headerReview = { total: counts.total, clang: counts.clang, system: counts.system, libcxx: counts.libcxx };
  });
  verify(directory, ndk, rootNotices);
}));

test('wrong embedded toolchain original range rejects', () => fixture(directory => {
  editManifest(directory, data => { data.embeddedToolchainOriginal.aggregateByteStart++; });
  assert.throws(() => verify(directory, ndk, rootNotices), /embedded toolchain original binding changed/);
}));
test('missing embedded toolchain original binding rejects', () => fixture(directory => {
  editManifest(directory, data => { delete data.embeddedToolchainOriginal; });
  assert.throws(() => verify(directory, ndk, rootNotices), /embedded toolchain original binding changed/);
}));

test('embedded range cannot extend beyond the aggregate', () => fixture(directory => {
  const original = manifest.originals.find(item => item.file === manifest.embeddedToolchainOriginal.file);
  editManifest(directory, data => { data.embeddedToolchainOriginal.aggregateByteEndExclusive = original.bytes + 1; });
  assert.throws(() => verify(directory, ndk, rootNotices), /embedded toolchain original binding changed/);
}));
