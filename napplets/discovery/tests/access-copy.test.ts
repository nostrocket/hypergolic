import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accessCopy} from '../src/access-copy.ts';

test('access details describe declarations independently of a shell grant', () => {
  assert.equal(accessCopy('inc').name, 'Messages between napplets');
  assert.equal(accessCopy('cvm').name, 'External tools');
  for (const domain of ['shell','identity','storage','theme','relay','resource','upload','link','intent','inc','notify','config','outbox','keys','media','cvm','lists','common']) {
    assert.notEqual(accessCopy(domain).name, domain);
    assert.ok(accessCopy(domain).description.length > 20);
  }
  assert.match(accessCopy('future-domain').description, /Unrecognized capability/);
});
