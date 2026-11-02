const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const plugin = require(path.join(root, 'plugins/withNativeCodecPatches.cjs'));
const generated = fs.readFileSync(path.join(root, 'ios/Podfile'), 'utf8');
const marker = "    require_relative '../plugins/native-codec-patches'";
const applyLine = '    HypergolicNativeCodecPatches.apply(installer.sandbox.root.to_s)';
const clean = generated.split('\n').filter(line => !line.includes("pod 'libdav1d'") && line !== marker && line !== applyLine).join('\n');
async function transform(contents) {
  const config = plugin({ name: 'Hypergolic', slug: 'hypergolic' });
  const result = await config.mods.ios.podfile({ ...config, modResults: { contents }, modRequest: { platform: 'ios', modName: 'podfile' } });
  return result.modResults.contents;
}
test('actual Expo plugin reconstructs the installed Podfile and preserves repeated generation', async () => {
  assert.equal(await transform(clean), generated);
  assert.equal(await transform(generated), generated);
});
test('changed source pin is rejected', async () => {
  await assert.rejects(transform(generated.replace(':submodules => true', ':submodules => false')), /source pin changed/);
});
test('duplicate post-install templates are rejected', async () => {
  await assert.rejects(transform(clean + '\n  post_install do |installer|\n'), /post-install template changed/);
});
test('a patch marker without its call is rejected', async () => {
  await assert.rejects(transform(generated.replace(applyLine, '')), /patch hook changed/);
});
