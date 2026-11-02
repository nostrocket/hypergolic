'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function verify(directory, selectedCompiler) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'android' ||
      manifest.scope !== 'compiler-defined-generated-helper-original') {
    throw new Error('Unexpected Android compiler notice manifest');
  }
  const { compiler, original } = manifest;
  if (!compiler || !original || typeof original.file !== 'string' ||
      path.basename(original.file) !== original.file || !original.file.endsWith('.txt') ||
      !/^[a-f0-9]{64}$/.test(original.sha256) || !/^[a-f0-9]{40}$/.test(original.gitBlob) ||
      !Number.isSafeInteger(original.bytes) || original.bytes < 1) {
    throw new Error('Unsafe or incomplete Android compiler original');
  }
  if (JSON.stringify(fs.readdirSync(directory).sort()) !==
      JSON.stringify([original.file, 'manifest.json'].sort())) {
    throw new Error('Android compiler notice file set changed');
  }
  const bytes = fs.readFileSync(path.join(directory, original.file));
  const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== original.bytes || sha256(bytes) !== original.sha256 || gitBlob !== original.gitBlob) {
    throw new Error('Android compiler original bytes changed');
  }
  if (!/^[a-f0-9]{40}$/.test(compiler.upstreamCommit) ||
      !/^[a-f0-9]{64}$/.test(compiler.sha256) ||
      original.source !== `https://r8.googlesource.com/r8/+/${compiler.upstreamCommit}/LICENSE`) {
    throw new Error('Android compiler immutable source binding changed');
  }
  if (!selectedCompiler || selectedCompiler.component !== compiler.component ||
      selectedCompiler.embeddedD8Version !== compiler.embeddedD8Version ||
      selectedCompiler.upstreamCommit !== compiler.upstreamCommit ||
      typeof selectedCompiler.file !== 'string' || !path.isAbsolute(selectedCompiler.file) ||
      path.basename(selectedCompiler.file) !== compiler.filename ||
      typeof selectedCompiler.d8CodeSource !== 'string' ||
      !selectedCompiler.d8CodeSource.startsWith('file:') ||
      fileURLToPath(selectedCompiler.d8CodeSource) !== selectedCompiler.file) {
    throw new Error('Android D8 class-loader origin or selected compiler changed');
  }
  const archive = fs.readFileSync(selectedCompiler.file);
  if (archive.length !== compiler.bytes || sha256(archive) !== compiler.sha256) {
    throw new Error('Android compiler archive bytes changed; refresh the original notice review');
  }
}

module.exports = { verify };
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Expected compiler notice directory and selected compiler inventory');
  verify(process.argv[2], JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
}
