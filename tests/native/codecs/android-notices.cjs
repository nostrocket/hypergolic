'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const { verify } = require('../../../modules/napplet-host/android/NativeDependencyNotices.cjs');
const source = path.join(root, 'modules/napplet-host/android/src/main/assets/notices');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));

function fixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hypergolic-android-notices-'));
  const directory = path.join(temporary, 'notices');
  fs.cpSync(source, directory, { recursive: true });
  try { run(directory, temporary); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function editManifest(directory, edit) {
  const file = path.join(directory, 'manifest.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(data);
  fs.writeFileSync(file, JSON.stringify(data));
}
const first = manifest.components.flatMap(component => component.notices)[0].file;
test('reviewed originals and installed dependency metadata pass', () => verify(source, root));
test('same-length altered attribution fails', () => fixture(directory => {
  const file = path.join(directory, first);
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, root), /notice bytes changed/);
}));
test('missing original fails', () => fixture(directory => {
  fs.unlinkSync(path.join(directory, first));
  assert.throws(() => verify(directory, root), /file set changed/);
}));
test('unreviewed extra notice fails', () => fixture(directory => {
  fs.writeFileSync(path.join(directory, 'extra.txt'), 'unreviewed');
  assert.throws(() => verify(directory, root), /file set changed/);
}));
test('missing shared React Native original mapping fails', () => fixture(directory => {
  editManifest(directory, data => {
    data.components.find(component => !component.notices.length).licenseNoticeFiles = ['missing.txt'];
  });
  assert.throws(() => verify(directory, root), /Shared Android notice missing/);
}));
test('unsafe notice filename fails before file access', () => fixture(directory => {
  editManifest(directory, data => { data.components[0].notices[0].file = '../outside.txt'; });
  assert.throws(() => verify(directory, root), /unsafe Android notice/);
}));
test('changed installed metadata rejects the stale profile', () => fixture((directory, temporary) => {
  const dependencyRoot = path.join(temporary, 'dependencies');
  for (const name of Object.keys(manifest.mainJavaScriptProfile.dependencyInputs)) {
    const destination = path.join(dependencyRoot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, name), destination);
  }
  verify(directory, dependencyRoot);
  fs.appendFileSync(path.join(dependencyRoot, 'package.json'), '\n');
  assert.throws(() => verify(directory, dependencyRoot), /dependency inputs changed/);
}));
test('unsafe dependency input fails before file access', () => fixture(directory => {
  editManifest(directory, data => { data.mainJavaScriptProfile.dependencyInputs = { '../outside.json': 'irrelevant' }; });
  assert.throws(() => verify(directory, root), /Unsafe Android notice dependency input/);
}));
