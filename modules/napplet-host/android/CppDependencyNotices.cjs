'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function safeRelative(name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) ||
      name.includes('\\') || name.split('/').some(part => part === '..' || !part)) {
    throw new Error('Unsafe Android C++ notice input');
  }
  return name;
}
function verify(directory, ndkDirectory, rootNoticeDirectory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'android' ||
      manifest.scope !== 'reviewed-arm64-ndk-cpp-originals') {
    throw new Error('Unexpected Android C++ notice manifest');
  }
  const names = manifest.originals.map(original => safeRelative(original.file));
  if (new Set(names).size !== names.length || names.some(name => path.basename(name) !== name || !name.endsWith('.txt'))) {
    throw new Error('Duplicate or unsafe Android C++ original filename');
  }
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([...names, 'manifest.json'].sort())) {
    throw new Error('Android C++ notice file set changed');
  }
  for (const original of manifest.originals) {
    const bytes = fs.readFileSync(path.join(directory, original.file));
    if (bytes.length !== original.bytes || sha256(bytes) !== original.sha256) {
      throw new Error(`Android C++ original bytes changed: ${original.file}`);
    }
  }
  const profile = manifest.ndkProfile;
  const properties = fs.readFileSync(path.join(ndkDirectory, 'source.properties'), 'utf8');
  if (!properties.split(/\r?\n/).some(line => line.trim() === `Pkg.Revision = ${profile.version}`)) {
    throw new Error('Android C++ NDK version changed; refresh the notice review');
  }
  for (const [name, expected] of Object.entries({ ...profile.inputs, ...profile.compilerHeaders })) {
    safeRelative(name);
    if (sha256(fs.readFileSync(path.join(ndkDirectory, name))) !== expected) {
      throw new Error(`Android C++ reviewed NDK input changed: ${name}`);
    }
  }
  verifyAggregateOriginals(manifest, directory, ndkDirectory, names);
  const aggregate = fs.readFileSync(path.join(ndkDirectory, 'NOTICE.toolchain'));
  if (sha256(aggregate) !== profile.aggregateSha256) throw new Error('Android C++ aggregate notice changed');
  for (const binding of manifest.noticeBindings) {
    if (!names.includes(binding.file) || !names.includes(binding.creditsFile) ||
        !Number.isSafeInteger(binding.aggregateByteStart) || !Number.isSafeInteger(binding.aggregateByteEndExclusive) ||
        binding.aggregateByteStart < 0 || binding.aggregateByteEndExclusive > aggregate.length ||
        binding.aggregateByteStart >= binding.aggregateByteEndExclusive ||
        !aggregate.subarray(binding.aggregateByteStart, binding.aggregateByteEndExclusive)
          .equals(fs.readFileSync(path.join(directory, binding.file)))) {
      throw new Error('Android C++ original aggregate binding changed');
    }
  }
  for (const binding of manifest.rootNoticeBindings) {
    for (const name of binding.files) {
      safeRelative(name);
      if (path.basename(name) !== name || sha256(fs.readFileSync(path.join(rootNoticeDirectory, name))) !== binding.sha256) {
        throw new Error('Android local C++ package original changed');
      }
    }
  }
}
function verifyAggregateOriginals(manifest, directory, ndkDirectory, names) {
  const profile = manifest.ndkProfile;
  const base = `toolchains/llvm/prebuilt/${profile.host}`;
  const required = ['NOTICE.toolchain', `${base}/sysroot/NOTICE`].sort();
  if (!Array.isArray(manifest.aggregateOriginals) ||
      JSON.stringify(manifest.aggregateOriginals.map(binding => binding.source).sort()) !== JSON.stringify(required)) {
    throw new Error('Android NDK aggregate original set changed');
  }
  for (const binding of manifest.aggregateOriginals) {
    safeRelative(binding.source);
    if (!names.includes(binding.file) || profile.inputs[binding.source] !== binding.sourceSha256 ||
        !fs.readFileSync(path.join(ndkDirectory, binding.source))
          .equals(fs.readFileSync(path.join(directory, binding.file)))) {
      throw new Error('Android NDK complete aggregate original binding changed');
    }
  }
  const embedded = manifest.embeddedToolchainOriginal;
  const aggregateBytes = embedded && names.includes(embedded.file)
    ? fs.readFileSync(path.join(directory, embedded.file)) : null;
  if (!embedded || embedded.source !== `${base}/NOTICE` || !names.includes(embedded.file) ||
      profile.inputs[embedded.source] !== embedded.sourceSha256 ||
      !Number.isSafeInteger(embedded.aggregateByteStart) || !Number.isSafeInteger(embedded.aggregateByteEndExclusive) ||
      embedded.aggregateByteStart < 0 || embedded.aggregateByteStart >= embedded.aggregateByteEndExclusive ||
      embedded.aggregateByteEndExclusive > aggregateBytes.length ||
      !aggregateBytes.subarray(embedded.aggregateByteStart, embedded.aggregateByteEndExclusive)
        .equals(fs.readFileSync(path.join(ndkDirectory, embedded.source)))) {
    throw new Error('Android NDK embedded toolchain original binding changed');
  }
  const headers = Object.keys(profile.compilerHeaders);
  const counts = { libcxx: 0, system: 0, clang: 0, total: headers.length };
  for (const name of headers) {
    if (name.startsWith(`${base}/sysroot/usr/include/c++/`)) counts.libcxx++;
    else if (name.startsWith(`${base}/sysroot/usr/include/`)) counts.system++;
    else if (name.startsWith(`${base}/lib/clang/18/include/`)) counts.clang++;
    else throw new Error('Unexpected Android NDK compiled header family');
  }
  if (Object.keys(profile.headerReview ?? {}).length !== 4 ||
      Object.entries(counts).some(([family, count]) => profile.headerReview?.[family] !== count)) {
    throw new Error('Android NDK reviewed header counts changed');
  }
}
module.exports = { verify };
if (require.main === module) {
  if (process.argv.length !== 5) throw new Error('Expected C++ notice, NDK and package notice directories');
  verify(...process.argv.slice(2));
}
