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

test('Expo template discovery includes dotfiles and skips symlink contents', async t => {
  const cwd = fixture(t);
  const { getTemplateFilesToRenameAsync } = cli('./build/src/prebuild/renameTemplateAppName.js');
  const files = await getTemplateFilesToRenameAsync(cwd, { renameConfig: ['src/**/*.{js,ts}'] });
  assert.deepEqual(files.sort(), ['src/.hidden.ts', 'src/a.js', 'src/b.ts', 'src/deep/c.ts', 'src/skip.test.ts']);
  assert.deepEqual(await getTemplateFilesToRenameAsync(cwd, { renameConfig: ['absent/**/*.ts'] }), []);
});

test('Expo CLI finds the native project, prefers its workspace and rejects missing projects', async t => {
  const cwd = fixture(t);
  const { resolveXcodeProject } = cli('./build/src/run/ios/options/resolveXcodeProject.js');
  assert.deepEqual(await resolveXcodeProject(cwd), { name: path.join(cwd, 'ios/Main.xcodeproj'), isWorkspace: false });
  mkdirSync(path.join(cwd, 'ios/Main.xcworkspace'));
  assert.deepEqual(await resolveXcodeProject(cwd), { name: path.join(cwd, 'ios/Main.xcworkspace'), isWorkspace: true });
  rmSync(path.join(cwd, 'ios'), { recursive: true });
  await assert.rejects(resolveXcodeProject(cwd), /Xcode project not found/);
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
