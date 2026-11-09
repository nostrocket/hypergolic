import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from '../vendor/legacy-recipe/zod.mjs';

test('oversized constrained arrays reject before reading children or running refinements', () => {
  let children = 0, refinements = 0;
  const element = z.preprocess(value => {children++; return value;}, z.string());
  const huge = new Array(1_000_000);
  Object.defineProperty(huge, 0, {get() {throw new Error('Oversized input element was read');}});
  for (const schema of [z.array(element).max(2, 'too many'), z.array(element).length(2, 'too many')]) {
    const result = schema.refine(() => {refinements++; return true;}).safeParse(huge);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
    assert.equal(result.error.issues[0].message, 'too many');
  }
  assert.equal(children, 0); assert.equal(refinements, 0);
});
test('oversized constrained arrays abort asynchronously and retain nested error paths', async () => {
  let children = 0, refinements = 0;
  const element = z.preprocess(async value => {children++; return value;}, z.string());
  const schema = z.object({items: z.array(element).max(2).refine(async () => {refinements++; return true;})});
  const result = await schema.safeParseAsync({items: new Array(100_000)});
  assert.equal(result.success, false); assert.equal(result.error.issues.length, 1);
  assert.deepEqual(result.error.issues[0].path, ['items']); assert.equal(result.error.issues[0].code, 'too_big');
  assert.equal(children, 0); assert.equal(refinements, 0);
});
test('oversized sets reject max and exact size before iterating in sync and async parses', async () => {
  let children = 0, refinements = 0;
  const element = z.preprocess(value => {children++; return value;}, z.string());
  const input = new Set([1, 2, 3]);
  input.values = () => {throw new Error('Oversized set was iterated');};
  for (const schema of [z.set(element).max(2, 'too many'), z.set(element).size(2, 'too many')]) {
    const refined = schema.refine(() => {refinements++; return true;});
    for (const result of [refined.safeParse(input), await refined.safeParseAsync(input)]) {
      assert.equal(result.success, false); assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big'); assert.equal(result.error.issues[0].message, 'too many');
    }
  }
  assert.equal(children, 0); assert.equal(refinements, 0);
});
test('ordinary Zod 3 schema API, lower bounds, transforms, wrong types and valid parsing are retained', async () => {
  const recipe = z.object({title: z.string().trim().min(1).max(200), ingredients: z.array(z.object({name: z.string().min(1)})).min(1).max(40)});
  assert.deepEqual(recipe.parse({title: ' Rice ', ingredients: [{name: 'rice'}], extra: true}), {title: 'Rice', ingredients: [{name: 'rice'}]});
  assert.deepEqual(await recipe.parseAsync({title: 'Rice', ingredients: [{name: 'rice'}]}), {title: 'Rice', ingredients: [{name: 'rice'}]});
  assert.equal(z.array(z.string()).max(2).safeParse('wrong type').error.issues[0].code, 'invalid_type');
  assert.equal(z.set(z.string()).max(2).safeParse([]).error.issues[0].code, 'invalid_type');
  assert.equal(z.array(z.string()).length(2).safeParse(['a']).error.issues[0].code, 'too_small');
  assert.equal(z.set(z.string()).size(2).safeParse(new Set(['a'])).error.issues[0].code, 'too_small');
  assert.deepEqual(z.preprocess(input => input.slice(0, 2), z.array(z.number()).max(2)).parse([1, 2, 3]), [1, 2]);
  assert.deepEqual(z.array(z.number()).max(2).transform(input => input.map(number => number * 2)).parse([1, 2]), [2, 4]);
  assert.deepEqual(z.set(z.string()).size(2).parse(new Set(['a', 'b'])), new Set(['a', 'b']));
  // The upstream fix deliberately leaves unbounded collections unchanged.
  assert.equal(z.array(z.string()).safeParse([1, 2, 3]).error.issues.length, 3);
  assert.equal(typeof z.map(z.string(), z.string()).max, 'undefined');
});
