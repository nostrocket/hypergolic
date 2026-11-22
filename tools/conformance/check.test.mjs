import assert from 'node:assert/strict';
import test from 'node:test';
import { assess, gate } from './report.mjs';
import { compareSpecs, driftReport } from './drift.mjs';

const one = '1'.repeat(40), two = '2'.repeat(40);
const spec = {repo:'owner/repo', path:'spec.md', ref:'draft', revision:one};
const catalog = {draft:spec};
const rule = {id:'sample', spec:'draft', section:'identity', title:'Example'};
test('a baseline excuses only a measured failure on that rule', async () => {
  const run = (value, issue) => assess([{...rule, issue}], {sample:async () => value}, catalog);
  assert.equal(gate(await run(true)), true);
  assert.equal(gate(await run(false)), false);
  assert.equal(gate(await run(false, 2)), true);
  assert.equal(gate(await run(false, 2), true), false);
  assert.equal(gate(await run(true, 2)), false);
  assert.equal(gate(await run(undefined, 2)), false);
  const broken = await assess([{...rule, issue:2}], {sample:() => { throw Error('fixture unavailable'); }}, catalog);
  assert.equal(gate(broken), false);
  await assert.rejects(assess([rule], {}, catalog));
  await assert.rejects(assess([rule, rule], {sample:() => true}, catalog));
  await assert.rejects(assess([], {}, catalog));
});
test('drift compares document bytes, detects removal and fails on incomplete upstream reads', async () => {
  const request = current => async url => {
    if (url.includes('/commits/')) return {sha:two};
    return url.endsWith(one) ? {sha:one} : current;
  };
  assert.deepEqual(await compareSpecs(catalog, request({sha:one})), []);
  const [changed] = await compareSpecs(catalog, request({sha:two}));
  assert.equal(changed.head, two);
  const summary = driftReport([{...changed, name:'NAP-CONFIG'}]);
  assert.match(summary, /config-default, config-user-choice/);
  assert.match(summary, /#diff-[0-9a-f]{64}/);
  const [deleted] = await compareSpecs(catalog, request(null));
  assert.equal(deleted.removed, true);
  await assert.rejects(compareSpecs(catalog, request({})));
  await assert.rejects(compareSpecs(catalog, async () => { throw Error('unavailable'); }));
});
