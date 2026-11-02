import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const quality = createRequire(new URL('../../tools/quality/package.json', import.meta.url));
const scanner = createRequire(quality.resolve('aislop'));
const matcher = createRequire(scanner.resolve('micromatch'));
const root = createRequire(new URL('../../package.json', import.meta.url));
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const metro = createRequire(cli.resolve('@expo/metro-file-map'));
const metroMatcher = createRequire(metro.resolve('micromatch'));
for (const [consumer, braces, micromatch] of [
  ['scanner', matcher('braces'), scanner('micromatch')],
  ['Expo Metro', metroMatcher('braces'), metro('micromatch')],
]) {
const nesting = depth => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);
for (const method of ['parse', 'compile', 'expand', 'stringify']) test('installed ' + consumer + ' braces bounds ' + method + ' string nesting', () => {
  assert.throws(() => braces[method](nesting(4000)), /fixed depth limit of 256/);
  assert.throws(() => braces[method]('('.repeat(4000) + 'x' + ')'.repeat(4000)), /fixed depth limit of 256/);
});
function ast(depth) {let node = {type: 'text', value: 'x'}; for (let n = 0; n < depth; n++) node = {type: 'root', nodes: [node], queue: []}; return node;}
for (const method of ['compile', 'expand', 'stringify']) test(consumer + ' direct deep AST is bounded in ' + method, () => {
  assert.throws(() => braces[method](ast(6000)), /fixed depth limit of 256/);
});
test(consumer + ' ordinary brace expansion and glob matching retain expected results', () => {
  assert.deepEqual(braces.expand('src/{links,runtime}/*.{ts,tsx}'), ['src/links/*.ts', 'src/links/*.tsx', 'src/runtime/*.ts', 'src/runtime/*.tsx']);
  assert.equal(braces.compile('a/{b,c}/d'), 'a/(b|c)/d');
  assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
  assert.deepEqual(micromatch(['src/links/a.ts','src/runtime/b.tsx','src/private/x.txt'], ['src/{links,runtime}/*.{ts,tsx}']), ['src/links/a.ts','src/runtime/b.tsx']);
  assert.equal(micromatch.isMatch('src/links/a.ts', 'src/{links,runtime}/*.ts'), true);
});
}
