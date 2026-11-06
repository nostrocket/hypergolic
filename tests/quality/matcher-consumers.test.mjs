import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = createRequire(import.meta.url);
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const fingerprint = createRequire(cli.resolve('@expo/fingerprint/package.json'));
const plugins = createRequire(cli.resolve('@expo/config-plugins/package.json'));
const metro = createRequire(expo.resolve('@expo/metro-config/package.json'));
const cliMetro = createRequire(cli.resolve('@expo/metro-config/package.json'));
const doctor = createRequire(root.resolve('react-doctor'));
const hooks = createRequire(doctor.resolve('eslint-plugin-react-hooks'));
const eslint = createRequire(hooks.resolve('eslint'));
const configArray = createRequire(eslint.resolve('@eslint/config-array'));
const { ESLint } = hooks('eslint');

function relativePaths(directory, files) {
  return files.map(file => path.relative(directory, file).replaceAll(path.sep, '/')).sort();
}

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hypergolic-matcher-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const files = {
    'src/a.js': 'export const a = 1;',
    'src/b.ts': 'export const b = 1;',
    'src/skip.test.ts': 'export const test = 1;',
    'src/.hidden.ts': 'export const h = 1;',
    'src/deep/c.ts': 'export const c = 1;',
    'ignored/x.ts': 'export const x = 1;',
    '.hidden/y.ts': 'export const y = 1;',
    'packages/a/package.json': '{"name":"disposable-a"}',
    'packages/b/package.json': 'invalid json',
    'packages/node_modules/package.json': '{"name":"must-be-ignored"}',
    'packages/Carthage/package.json': '{"name":"must-be-ignored"}',
    'packages/Pods/package.json': '{"name":"must-be-ignored"}',
    'ios/Main.xcodeproj/project.pbxproj': '',
    'ios/Pods/Skip.xcodeproj/project.pbxproj': '',
    'ios/Main.xcodeproj/xcshareddata/xcschemes/Main.xcscheme': '',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  symlinkSync('deep', path.join(directory, 'src/link'), 'dir');
  return directory;
}

for (const [name, consumer] of Object.entries({ cli, fingerprint })) {
  test(`Expo ${name} glob preserves discovery, ignores and symlink options`, async t => {
    const cwd = fixture(t);
    const { glob, globStream, globSync } = consumer('glob');
    const pattern = 'src/**/*.{js,ts}';
    const expected = ['src/.hidden.ts', 'src/a.js', 'src/b.ts', 'src/deep/c.ts'];
    const options = {
      cwd,
      absolute: true,
      dot: true,
      nodir: true,
      follow: false,
      ignore: ['**/*.test.ts', 'src/link/**'],
    };

    assert.deepEqual(relativePaths(cwd, globSync(pattern, options)), expected, 'sync');
    assert.deepEqual(relativePaths(cwd, await glob(pattern, options)), expected, 'async');

    const streamed = [];
    for await (const file of globStream(pattern, options)) streamed.push(file);
    assert.deepEqual(relativePaths(cwd, streamed), expected, 'stream');

    assert.deepEqual(
      relativePaths(cwd, globSync('src/@(a|b).@(js|ts)', options)),
      ['src/a.js', 'src/b.ts'],
      'extglob',
    );
    assert.deepEqual(
      relativePaths(cwd, globSync('src/link/*.ts', { cwd, absolute: true, follow: false })),
      ['src/link/c.ts'],
      'explicit symlink path',
    );
    assert.deepEqual(
      relativePaths(cwd, globSync('src/**/*.ts', {
        cwd, absolute: true, follow: true, ignore: ['**/*.test.ts'],
      })),
      ['src/b.ts', 'src/deep/c.ts', 'src/link/c.ts'],
      'follow symlink',
    );
  });
}

test('Expo CLI wrappers return all matches, one match, or no matches', async t => {
  const cwd = fixture(t);
  const { anyMatchAsync, everyMatchAsync } = cli('./build/src/utils/glob.js');
  const pattern = 'src/**/*.ts';
  const options = { cwd, ignore: ['src/link/**'] };

  const all = await everyMatchAsync(pattern, options);
  assert.deepEqual(all.sort(), ['src/b.ts', 'src/deep/c.ts', 'src/skip.test.ts']);
  const one = await anyMatchAsync(pattern, options);
  assert.equal(one.length, 1);
  assert.ok(all.includes(one[0]));
  assert.deepEqual(await anyMatchAsync('absent/**/*.ts', { cwd }), []);
});

test('native config finds the main scheme and ignores dependency projects', t => {
  const directory = fixture(t);
  const { findSchemeNames, getAllXcodeProjectPaths } = plugins('./build/ios/Paths.js');

  assert.deepEqual(findSchemeNames(directory), ['Main']);
  assert.deepEqual(relativePaths(directory, getAllXcodeProjectPaths(directory)), ['ios/Main.xcodeproj']);
});

for (const [name, consumer] of Object.entries({ metro, cliMetro })) {
  test(`Expo ${name} discovers only valid workspace package files`, t => {
    const directory = fixture(t);
    const { globAllPackageJsonPaths } = consumer('./build/getWatchFolders.js');

    for (const pattern of ['packages/*', 'packages/**']) {
      assert.deepEqual(
        relativePaths(directory, globAllPackageJsonPaths(directory, [pattern])),
        ['packages/a/package.json'],
        pattern,
      );
    }
  });
}

test('Expo fingerprint handles ordered negation, dotfiles and parent paths', () => {
  const {
    appendIgnorePath, buildDirMatchObjects, buildPathMatchObjects, isIgnoredPath,
    isIgnoredPathWithMatchObjects,
  } = fingerprint('./build/utils/Path.js');
  const patterns = ['**/node_modules/**', '!**/node_modules/keep/**'];

  assert.equal(isIgnoredPath('../node_modules/pkg/index.js', patterns), true);
  assert.equal(isIgnoredPath('../node_modules/keep/index.js', patterns), false);
  assert.equal(isIgnoredPath('src/.hidden.ts', ['src/**']), true);

  const objects = buildPathMatchObjects(['generated/**']);
  appendIgnorePath(objects, 'cache/**');
  assert.equal(isIgnoredPathWithMatchObjects('cache/a.js', objects), true);
  assert.equal(isIgnoredPathWithMatchObjects('src/a.js', objects), false);

  const directoryIgnores = buildPathMatchObjects(['node_modules/**', '!node_modules/keep/**']);
  assert.deepEqual(buildDirMatchObjects(directoryIgnores).map(item => item.pattern), []);
});

test('ESLint selects the expected source files and respects exclusions', async t => {
  const cwd = fixture(t);
  const engine = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ['ignored/**', 'src/link/**', '**/*.test.ts', '**/.*'] },
      {
        files: ['src/**/*.{js,ts}'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        rules: {},
      },
    ],
  });

  const results = await engine.lintFiles(['src']);
  assert.deepEqual(relativePaths(cwd, results.map(item => item.filePath)), [
    'src/a.js', 'src/b.ts', 'src/deep/c.ts',
  ]);
  assert.equal(results.reduce((sum, item) => sum + item.errorCount + item.warningCount, 0), 0);
});

for (const [name, consumer] of Object.entries({ fingerprint, eslint, configArray })) {
  test(`${name} minimatch preserves negation fields, dotfiles and Windows matching`, () => {
    const { Minimatch } = consumer('minimatch');
    const negated = new Minimatch('!**/*.test.{js,ts}', { dot: true });

    assert.equal(negated.negate, true);
    assert.equal(negated.pattern, '**/*.test.{js,ts}');
    assert.equal(negated.match('src/file.test.ts'), false);
    assert.equal(negated.match('src/.normal.ts'), true);

    const windows = new Minimatch('C:/**/FILE.TS', { platform: 'win32', nocase: true });
    assert.equal(windows.match('c:/src/file.ts'), true);
    assert.equal(new Minimatch('a/**/b', { dot: false }).match('a/.hidden/b'), false);
  });
}
