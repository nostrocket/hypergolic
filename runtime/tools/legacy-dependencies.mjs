import {readFile, writeFile, mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url), vendor = new URL('vendor/legacy-recipe/', root);
const manifest = JSON.parse(await readFile(new URL('manifest.json', vendor), 'utf8'));
const packageInputs = [
  {name: 'zod', version: '3.23.8', tarball: 'https://registry.npmjs.org/zod/-/zod-3.23.8.tgz', integrity: 'sha512-XBx9AXhXktjUqnepgTiE5flcKIYWi/rme0Eaj+5Y0lftuGBq+jyRu/md4WnuxqgP1ubdpNCsYEYPxrzVHD8d6g=='},
  {name: '@noble/hashes', version: '1.4.0', tarball: 'https://registry.npmjs.org/@noble/hashes/-/hashes-1.4.0.tgz', integrity: 'sha512-V1JJ1WTRUqHHrOSh597hURcMqVKVGL/ea3kv0gSnEdsEZ0/+VyPghM1lMNGc00z7CIQorSvbKpuJkxvuHbvdbg=='},
  {name: '@noble/curves', version: '1.4.0', tarball: 'https://registry.npmjs.org/@noble/curves/-/curves-1.4.0.tgz', integrity: 'sha512-p+4cb332SFCrReJkCYe8Xzm0OWi4Jji5jVdIZRL/PmacmDkFNw6MrrV+gGpiPxLHbV+zKFRywUWbaseT+tZRXg=='},
];
assert.deepEqual(manifest.packages.map(({name, version, tarball, integrity}) => ({name, version, tarball, integrity})), packageInputs);
assert.deepEqual(manifest.modules.map(module => module.file), ['zod.mjs', 'sha256.mjs', 'utils.mjs', 'secp256k1.mjs']);
assert.equal(manifest.patches.length, 1);
assert.equal(manifest.patches[0].file, 'zod-size-gate.patch');
assert.equal(manifest.patches[0].path, 'zod/lib/index.mjs');
const sha = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest(algorithm === 'sha512' ? 'base64' : 'hex');
for (const patch of manifest.patches ?? []) {
  assert.equal(sha(await readFile(new URL(patch.file, vendor))), patch.sha256, 'Reviewed dependency patch changed');
  assert.equal(manifest.modules.find(module => module.file === 'zod.mjs').sources.find(source => source.path === patch.path).sha256, patch.patchedSha256);
}
if (process.argv.includes('--regenerate')) {
  // Explicit maintainer operation only: official tarballs and reviewed integrity pins, never live CDN imports.
  const scratch = await mkdtemp(join(tmpdir(), 'hypergolic-legacy-'));
  const require = createRequire(import.meta.url), viteRequire = createRequire(require.resolve('vite/package.json'));
  const {build, version} = viteRequire('esbuild');
  assert.equal(version, manifest.builder.version);
  for (const pkg of packageInputs) {
    const reply = await fetch(pkg.tarball, {redirect: 'error', signal: AbortSignal.timeout(15_000)}); assert(reply.ok); const bytes = Buffer.from(await reply.arrayBuffer());
    assert.equal('sha512-' + sha(bytes, 'sha512'), pkg.integrity);
    const folder = join(scratch, 'node_modules', pkg.name); await mkdir(folder, {recursive: true});
    execFileSync('tar', ['-xzf', '-', '--strip-components=1', '-C', folder], {input: bytes});
    assert.equal(await readFile(join(folder, 'LICENSE'), 'utf8'), manifest.packages.find(record => record.name === pkg.name).licenseText);
  }
  for (const patch of manifest.patches ?? []) {
    const path = join(scratch, 'node_modules/zod/lib/index.mjs');
    assert.equal(sha(await readFile(path)), patch.baseSha256, 'Base dependency source changed');
    execFileSync('patch', ['-p1', '-F0', '--batch', '--forward', '-i', new URL('zod-size-gate.patch', vendor).pathname], {cwd: scratch, stdio: 'pipe'});
    assert.equal(sha(await readFile(path)), patch.patchedSha256, 'Patched dependency source changed');
  }
  const entries = ['zod/lib/index.mjs', '@noble/hashes/esm/sha256.js', '@noble/hashes/esm/utils.js', '@noble/curves/esm/secp256k1.js'];
  for (const [index, module] of manifest.modules.entries()) {
    const built = await build({absWorkingDir: scratch, entryPoints: [join(scratch, 'node_modules', entries[index])],
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, metafile: true, legalComments: 'inline'});
    const bytes = built.outputFiles[0].contents;
    assert.equal(sha(bytes), module.sha256, 'Regeneration changed reviewed dependency bytes');
    const sources = await Promise.all(Object.keys(built.metafile.inputs).map(async path => {
      const bytes = await readFile(resolve(scratch, path));
      return {path: path.replace(/^node_modules\//, ''), sha256: sha(bytes), bytes: bytes.length};
    }));
    assert.deepEqual(sources, module.sources, 'Dependency source graph changed');
    await writeFile(new URL(module.file, vendor), bytes);
  }
}
const modules = {};
assert.deepEqual(manifest.modules.map(m => m.specifier), ['https://esm.sh/zod@3.23.8',
  'https://esm.sh/@noble/hashes@1.4.0/sha256', 'https://esm.sh/@noble/hashes@1.4.0/utils', 'https://esm.sh/@noble/curves@1.4.0/secp256k1']);
for (const module of manifest.modules) {
  const bytes = await readFile(new URL(module.file, vendor)); assert.equal(bytes.length, module.bytes); assert.equal(sha(bytes), module.sha256);
  assert(!/\bimport\s*(?:\(|['"{*])|\bexport\s*\*\s*from/.test(bytes.toString()), 'Legacy modules must be self-contained');
  modules[module.specifier] = bytes.toString();
}
const generated = '// Generated from vendor/legacy-recipe; verify with tools/legacy-dependencies.mjs.\nexport const LEGACY_RECIPE_MODULES = ' + JSON.stringify(modules) + ' as const;\n';
assert.equal(await readFile(new URL('src/legacy-recipe-modules.ts', root), 'utf8'), generated);
const adaptationNotice = '\n\n-----\n\nHypergolic host-supplied adaptation: zod@3.23.8, local revision hypergolic-size-gate-1.\nThe bundled Zod module includes the oversized constrained-collection early-abort\nbackport from upstream commit a0ebf970f2d752e5f58527cd2942ff48be4f46bd.\nThe original signed Recipe Cards HTML is unchanged. See manifest.json and\nzod-size-gate.patch for the original release integrity, patch and source hashes.\n';
assert.equal(await readFile(new URL('LICENSES.txt', vendor), 'utf8'), manifest.packages.map(p => p.name + '@' + p.version + '\n\n' + p.licenseText).join('\n\n-----\n\n') + '\n' + adaptationNotice);
execFileSync(process.execPath, ['--test', new URL('./legacy-dependencies.test.mjs', import.meta.url).pathname], {stdio: 'inherit'});
process.stdout.write('Verified four local legacy modules, reviewed patch, source graph pins and original licenses.\n');
