import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDED_TEST_COORDINATE, EMBEDDED_TEST_EVENT, EMBEDDED_TEST_HTML,
  EMBEDDED_TEST_IDENTIFIER, EMBEDDED_TEST_PUBLISHER, getEmbeddedTestHtmlBytes,
  verifyEmbeddedTestFixture,
} from '../../src/napplets/embedded-test-fixture.ts';

test('embedded published-path fixture independently verifies as signed theme-only kind 35129', async () => {
  const { manifest, artifact } = await verifyEmbeddedTestFixture();
  assert.equal(EMBEDDED_TEST_EVENT.kind, 35129);
  assert.equal(EMBEDDED_TEST_EVENT.pubkey, EMBEDDED_TEST_PUBLISHER);
  assert.equal(EMBEDDED_TEST_COORDINATE.identifier, EMBEDDED_TEST_IDENTIFIER);
  assert.equal(manifest.id, EMBEDDED_TEST_EVENT.id);
  assert.equal(manifest.expectedHtmlHash, '34d8462c3b471aa01f1149f58441d200bd194d3097d36321777018a0a2adf1d5');
  assert.equal(manifest.aggregateHash, 'e1f514399537f8ff98ce2f842b6fbeb4f1f70edb82dde934197b2031184e4934');
  assert.deepEqual(manifest.requiredDomains, ['theme']);
  assert.deepEqual(new TextDecoder().decode(artifact.htmlBytes), EMBEDDED_TEST_HTML);
  assert.equal(Object.isFrozen(EMBEDDED_TEST_EVENT), true);
  assert.equal(Object.isFrozen(EMBEDDED_TEST_EVENT.tags), true);
  assert.ok(EMBEDDED_TEST_EVENT.tags.every(tag => Object.isFrozen(tag)));
  assert.equal(JSON.stringify(EMBEDDED_TEST_EVENT).includes('secret'), false);
});

test('fixture byte access is defensive and leaves the signed canonical bytes unchanged', async () => {
  const callerBytes = getEmbeddedTestHtmlBytes();
  callerBytes.fill(0);
  assert.equal(new TextDecoder().decode(getEmbeddedTestHtmlBytes()), EMBEDDED_TEST_HTML);
  await assert.rejects(async () => {
    const { manifest } = await verifyEmbeddedTestFixture();
    const altered = getEmbeddedTestHtmlBytes();
    altered[altered.length - 1] ^= 1;
    const { verifyArtifact } = await import('../../src/napplets/verified-artifact.ts');
    await verifyArtifact(manifest, altered);
  });
});
