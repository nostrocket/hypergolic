import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = createRequire(import.meta.url);
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const fingerprint = createRequire(cli.resolve('@expo/fingerprint/package.json'));
const doctor = createRequire(root.resolve('react-doctor'));
const hooks = createRequire(doctor.resolve('eslint-plugin-react-hooks'));
const eslint = createRequire(hooks.resolve('eslint'));
const configArray = createRequire(eslint.resolve('@eslint/config-array'));

const globManifest = cli.resolve('glob/package.json');
const globMetadata = cli('glob/package.json');
const globEsmEntry = path.resolve(path.dirname(globManifest), globMetadata.exports['.'].import.default);
const globCjs = cli('glob');
const globEsm = await import(pathToFileURL(globEsmEntry));
const globLibraries = { 'glob CJS': globCjs, 'glob ESM': globEsm };

function parentGlobstars(count) {
  return Array(count).fill('**/../a/b').join('/');
}

const growthPattern = parentGlobstars(8);
const maximum = 64;

for (const [name, { Glob }] of Object.entries(globLibraries)) {
  test(`${name} respects the configured pattern growth limit`, () => {
    const { patterns } = new Glob(growthPattern, { braceExpandMax: maximum });
    assert.ok(patterns.length <= maximum, `${patterns.length} selectors exceed ${maximum}`);
  });

  test(`${name} bounds parent globstars with default options`, () => {
    const { patterns } = new Glob(parentGlobstars(14), {});
    assert.ok(patterns.length <= 10_000, `${patterns.length} selectors exceed the default limit`);
  });
}

for (const [name, consumer] of Object.entries({ fingerprint, eslint, configArray })) {
  test(`${name} minimatch bounds pattern growth and preserves ordinary parent matches`, () => {
    const { Minimatch } = consumer('minimatch');
    const { set } = new Minimatch(growthPattern, {
      optimizationLevel: 2,
      braceExpandMax: maximum,
    });
    assert.ok(set.length <= maximum, `${set.length} selectors exceed ${maximum}`);

    const ordinary = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
    assert.equal(ordinary.match('../a/b/../c/d'), true);
    assert.equal(ordinary.match('x/a/b/y/c/d'), true);
  });
}

test('minimatch skips pairwise comparisons for a large selector set', () => {
  const { Minimatch } = fingerprint('minimatch');
  let comparisons = 0;
  class ObservedMinimatch extends Minimatch {
    partsMatch(...args) {
      comparisons++;
      return super.partsMatch(...args);
    }
  }

  const options = { optimizationLevel: 2 };
  new ObservedMinimatch(growthPattern, options);
  assert.ok(comparisons > 0, 'the smaller pattern exercises pairwise comparisons');

  comparisons = 0;
  const { set } = new ObservedMinimatch(parentGlobstars(10), options);
  assert.ok(set.length > 1000, 'the larger pattern exercises the comparison limit');
  assert.equal(comparisons, 0);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypergolic-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  function populate(base, depth) {
    for (let index = 0; index < 3; index++) {
      const child = path.join(base, `dir${index}`);
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, 'file.txt'), 'fixture');
      if (depth > 1) populate(child, depth - 1);
    }
  }
  populate(directory, 4);
  return directory;
}

function observeDirectoryReads({ beforeFirstCallback, afterFirstCallback } = {}) {
  let reads = 0;
  return {
    count: () => reads,
    fs: {
      ...fs,
      readdir(directory, options, callback) {
        const first = ++reads === 1;
        fs.readdir(directory, options, (error, entries) => {
          if (first) beforeFirstCallback?.();
          callback(error, entries);
          if (first) afterFirstCallback?.();
        });
      },
    },
  };
}

for (const [name, library] of Object.entries(globLibraries)) {
  const traversals = {
    promise: options => library.glob('**/*', options),
    stream: options => Array.fromAsync(library.globStream('**/*', options)),
  };

  for (const [mode, traverse] of Object.entries(traversals)) {
    test(`${name} ${mode} stops directory reads after cancellation`, async t => {
      const cwd = fixture(t);
      const controller = new AbortController();
      const rootRead = Promise.withResolvers();
      const observation = observeDirectoryReads({
        beforeFirstCallback: () => controller.abort(new Error('controlled cancellation')),
        afterFirstCallback: rootRead.resolve,
      });

      await assert.rejects(
        traverse({ cwd, fs: observation.fs, signal: controller.signal }),
        /controlled cancellation/,
      );
      await rootRead.promise;
      assert.equal(observation.count(), 1, 'the aborted root read must not start child reads');
    });
  }
}

test('Expo CLI stops directory reads after returning its first match', async t => {
  const cwd = fixture(t);
  const { anyMatchAsync } = cli('./build/src/utils/glob.js');
  const observation = observeDirectoryReads();

  const result = await anyMatchAsync('**/*', { cwd, fs: observation.fs });
  assert.equal(result.length, 1);
  const count = observation.count();
  assert.ok(count > 0, 'the traversal must have read a directory');

  // Observe background work after the caller receives the match.
  await setTimeout(100);
  assert.equal(observation.count(), count, 'new directory reads after the first match');
});

test('ordinary glob traversal still reads the complete tree', async t => {
  const cwd = fixture(t);
  const observation = observeDirectoryReads();

  const result = await globCjs.glob('**/*.txt', { cwd, fs: observation.fs });
  assert.equal(result.length, 120);
  assert.ok(observation.count() >= 121);
});
