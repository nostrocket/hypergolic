'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verify } = require('../../../modules/napplet-host/android/ArchiveDependencyNotices.cjs');
const source = path.resolve(__dirname, '../../../modules/napplet-host/android/src/main/assets/archive-notices');

function fixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hypergolic-archive-notices-'));
  const directory = path.join(temporary, 'notices');
  fs.cpSync(source, directory, { recursive: true });
  try {
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    // A disposable resolver result exercises graph drift without network or native builds.
    const artifact = path.join(temporary, 'licensed.jar');
    fs.writeFileSync(artifact, 'reviewed archive fixture');
    manifest.selectedArtifacts = [{ component: 'example:licensed:1', filename: 'licensed.jar',
      sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') }];
    for (const binding of manifest.prefabBindings) binding.owningArtifact = manifest.selectedArtifacts[0];
    for (const binding of manifest.prebuiltBindings) binding.owningArtifact = manifest.selectedArtifacts[0];
    const nativeEntries = [];
    for (const binding of manifest.nativeOwnerBindings) for (const image of binding.nativeImages) {
      image.owningArtifact = manifest.selectedArtifacts[0];
      if (!nativeEntries.some(entry => entry.entry === image.entry)) {
        nativeEntries.push({ entry: image.entry, bytes: image.bytes, sha256: image.sha256 });
      }
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    run(directory, [{ component: 'example:licensed:1', file: artifact, nativeEntries }], manifest);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('original archive notices and unchanged selected artifact pass', () => fixture((directory, artifacts) => verify(directory, artifacts)));
test('altered Apache copyright notice rejects', () => fixture((directory, artifacts, manifest) => {
  const notice = manifest.originals.find(original => original.file.includes('commons-io') && original.file.includes('NOTICE'));
  const file = path.join(directory, notice.file); const bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verify(directory, artifacts), /notice bytes changed/);
}));
test('missing Apache license original rejects', () => fixture((directory, artifacts, manifest) => {
  fs.unlinkSync(path.join(directory, manifest.originals[0].file));
  assert.throws(() => verify(directory, artifacts), /file set changed/);
}));
test('same coordinate with changed archive bytes rejects', () => fixture((directory, artifacts) => {
  fs.appendFileSync(artifacts[0].file, '!');
  assert.throws(() => verify(directory, artifacts), /selected archive inputs changed/);
}));
test('new unreviewed runtime dependency rejects', () => fixture((directory, artifacts) => {
  artifacts.push({ component: 'example:additional:1', file: artifacts[0].file });
  assert.throws(() => verify(directory, artifacts), /selected archive inputs changed/);
}));
test('removed runtime dependency rejects', () => fixture(directory => {
  assert.throws(() => verify(directory, []), /selected archive inputs changed/);
}));

function changeManifest(directory, edit) {
  const file = path.join(directory, 'manifest.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); edit(data); fs.writeFileSync(file, JSON.stringify(data));
}
test('changed prefab owning artifact binding rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prefabBindings[0].owningArtifact.sha256 = '0'.repeat(64); });
  assert.throws(() => verify(directory, artifacts), /prefab owning artifact binding changed/);
}));
test('changed shared React Native licence reference rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => {
    data.prefabBindings.flatMap(binding => binding.rootOriginals)
      .find(original => original.original.location === 'main-javascript').original.sha256 = '0'.repeat(64);
  });
  assert.throws(() => verify(directory, artifacts), /prefab shared original changed/);
}));
test('unsafe prefab header entry rejects before reuse', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prefabBindings[0].compiledHeaders[0].entry = 'prefab/modules/../outside'; });
  assert.throws(() => verify(directory, artifacts), /Unsafe or incomplete Android prefab header binding/);
}));
test('omitted reviewed prefab header rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prefabBindings[0].compiledHeaders.pop(); });
  assert.throws(() => verify(directory, artifacts), /prefab reviewed header set changed/);
}));
test('inline BSD notice cannot move to another header', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => {
    data.prefabBindings.find(binding => binding.inlineHeaderNotices.length).inlineHeaderNotices[0].headerSha256 = '0'.repeat(64);
  });
  assert.throws(() => verify(directory, artifacts), /prefab inline notice header binding changed/);
}));

test('changed prebuilt SQLite artifact binding rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].owningArtifact.sha256 = '0'.repeat(64); });
  assert.throws(() => verify(directory, artifacts), /prebuilt owning artifact binding changed/);
}));
test('altered SQLite upstream source reconstruction rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].originalSources[0].upstreamSha256 = '0'.repeat(64); });
  assert.throws(() => verify(directory, artifacts), /prebuilt original source provenance changed/);
}));
test('SQLite original notice cannot move to another source range', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].originalSources[0].byteStart++; });
  assert.throws(() => verify(directory, artifacts), /prebuilt original source range changed/);
}));
test('unsafe SQLite vendor source path rejects before reading', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].originalSources[0].path = '../outside'; });
  assert.throws(() => verify(directory, artifacts), /prebuilt source set changed/);
}));
test('changed Expo SQLite wrapper licence reference rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].wrapperOriginal.sha256 = '0'.repeat(64); });
  assert.throws(() => verify(directory, artifacts), /prebuilt wrapper original changed/);
}));
test('omitted reviewed SQLite binding rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings.pop(); });
  assert.throws(() => verify(directory, artifacts), /prebuilt reviewed source set changed/);
}));
test('wrong SQLite native architecture entry rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.prebuiltBindings[0].entry = 'jni/x86/libexpo-sqlite.so'; });
  assert.throws(() => verify(directory, artifacts), /prebuilt native entry binding changed/);
}));


test('missing current native archive capture rejects', () => fixture((directory, artifacts) => {
  delete artifacts[0].nativeEntries;
  assert.throws(() => verify(directory, artifacts), /native owning archive capture missing/);
}));
test('changed captured linked native bytes rejects', () => fixture((directory, artifacts) => {
  artifacts[0].nativeEntries[0].sha256 = '0'.repeat(64);
  assert.throws(() => verify(directory, artifacts), /native image archive bytes changed/);
}));
test('wrong native architecture entry rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.nativeOwnerBindings[0].nativeImages[0].entry = 'jni/x86/libgifimage.so'; });
  assert.throws(() => verify(directory, artifacts), /native image entry unsafe or incomplete/);
}));
test('native original cannot use an unsafe shared path', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.nativeOwnerBindings[0].originals[0].file = '../outside.txt'; });
  assert.throws(() => verify(directory, artifacts), /native original reference unsafe or incomplete/);
}));
test('native immutable original Git blob drift rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.nativeOwnerBindings[1].originals[0].gitBlob = '0'.repeat(40); });
  assert.throws(() => verify(directory, artifacts), /native original bytes or Git blob changed/);
}));
test('missing linked WebP patent original rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => { data.nativeOwnerBindings[1].originals.splice(1, 1); });
  assert.throws(() => verify(directory, artifacts), /native original or image reference set changed/);
}));


test('changed owning GIFLIB release archive rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => {
    data.nativeOwnerBindings.find(binding => binding.name === 'GIFLIB').sourceArchive.sha256 = '0'.repeat(64);
  });
  assert.throws(() => verify(directory, artifacts), /native owner provenance incomplete/);
}));
test('ambiguous Git and release archive provenance rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => {
    const binding = data.nativeOwnerBindings.find(binding => binding.name === 'GIFLIB');
    binding.resolvedCommit = 'a'.repeat(40); binding.tree = 'b'.repeat(40);
  });
  assert.throws(() => verify(directory, artifacts), /native owner provenance incomplete/);
}));
test('missing JPEG attribution original rejects', () => fixture((directory, artifacts) => {
  changeManifest(directory, data => {
    data.nativeOwnerBindings.find(binding => binding.name === 'libjpeg-turbo').originals.pop();
  });
  assert.throws(() => verify(directory, artifacts), /native original or image reference set changed/);
}));
