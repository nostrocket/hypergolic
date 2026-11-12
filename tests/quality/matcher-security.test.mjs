import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = createRequire(import.meta.url);
const expo = createRequire(root.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const fingerprint = createRequire(cli.resolve('@expo/fingerprint/package.json'));
const doctor = createRequire(root.resolve('react-doctor'));
const hooks = createRequire(doctor.resolve('eslint-plugin-react-hooks'));
const eslint = createRequire(hooks.resolve('eslint'));
const configArray = createRequire(eslint.resolve('@eslint/config-array'));

function parentGlobstars(count) {
  return Array(count).fill('**/../a/b').join('/');
}

const growthPattern = parentGlobstars(8);
const maximum = 64;

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
