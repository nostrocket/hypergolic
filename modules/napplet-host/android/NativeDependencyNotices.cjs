'use strict';

// Build-time integrity check for the reviewed Android JavaScript notices.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function verify(directory, projectRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'android' ||
      manifest.mainJavaScriptProfile.platform !== 'android') {
    throw new Error('Unexpected Android notice manifest');
  }
  const components = manifest.components;
  const identities = components.map(component => `${component.name}@${component.version}`);
  const notices = components.flatMap(component => component.notices);
  const names = notices.map(notice => notice.file);
  if (new Set(identities).size !== identities.length ||
      new Set(names).size !== names.length || names.some(name =>
        typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.txt'))) {
    throw new Error('Duplicate or unsafe Android notice identity or filename');
  }
  const expected = [...names, 'manifest.json'].sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected)) {
    throw new Error('Android notice file set changed');
  }
  for (const component of components) {
    const shared = component.licenseNoticeFiles || [];
    if ((!component.notices.length && !shared.length) || shared.some(name => !names.includes(name))) {
      throw new Error('Shared Android notice missing');
    }
  }
  const profile = manifest.mainJavaScriptProfile;
  if (profile.packageIdentityCount !== components.length ||
      profile.suppliedOriginalFileCount !== notices.length ||
      profile.sharedOriginalPackageCount !== components.filter(component => !component.notices.length).length) {
    throw new Error('Android notice profile counts changed');
  }
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const notice of notices) {
    const bytes = fs.readFileSync(path.join(directory, notice.file));
    if (bytes.length !== notice.bytes || sha256(bytes) !== notice.sha256) {
      throw new Error(`Android notice bytes changed: ${notice.file}`);
    }
  }
  if (!projectRoot) throw new Error('Android notice dependency root required');
  for (const [name, expectedHash] of Object.entries(profile.dependencyInputs)) {
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error('Unsafe Android notice dependency input');
    }
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expectedHash) {
      throw new Error(`Android notice dependency inputs changed: ${name}`);
    }
  }
}

module.exports = { verify };
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Expected notice directory and project root');
  verify(process.argv[2], process.argv[3]);
}
