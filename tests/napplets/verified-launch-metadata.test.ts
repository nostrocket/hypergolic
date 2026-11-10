import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { naddrEncode, neventEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createLaunchReviewMedia } from '../../src/napplets/launch-review-media.ts';
import { resolvePublishedReference } from '../../src/napplets/resolve-link.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { verifiedLaunchMetadata } from '../../src/napplets/verified-launch-metadata.ts';

const key = new Uint8Array(32);
key[31] = 9;
const publisher = getPublicKey(key);
const html = new TextEncoder().encode('<!doctype html><html><head><title>Fixture</title></head><body>ok</body></html>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNM0AAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const server = 'https://blossom.example.org/';

async function release(kind: 5129 | 35129, tags: string[][], content: string) {
  const signed = finalizeEvent({ kind, created_at: 1_700_000_000, content,
    tags: [...(kind === 35129 ? [['d', 'signed-review']] : []), ...tags] }, key);
  const reference = kind === 5129 ? neventEncode({ id: signed.id, kind, author: publisher })
    : naddrEncode({ kind, pubkey: publisher, identifier: 'signed-review' });
  const manifest = await verifyManifest(resolvePublishedReference(reference), JSON.parse(JSON.stringify(signed)));
  return { artifact: await verifyArtifact(manifest, html), reference };
}

test('launch metadata comes from the exact signed modern event and accepts only one supported icon descriptor', async () => {
  const tags = [['x', hash(html)], ['title', 'Field guide'], ['server', server], ['icon', hash(png), 'image/png']];
  const { artifact, reference } = await release(35129, tags, 'Identify local birds.\u202e');
  const metadata = verifiedLaunchMetadata(artifact);
  assert.deepEqual(metadata, {
    title: 'Field guide', description: 'Identify local birds.', reference,
    version: artifact.aggregateHash, htmlHash: artifact.htmlHash,
    icon: { hash: hash(png), mime: 'image/png', serverHints: [server] },
  });
  assert(Object.isFrozen(metadata.icon));
  assert.throws(() => verifiedLaunchMetadata({ ...artifact }));
  const ambiguous = await release(35129, [...tags, ['icon', hash(png), 'image/png']], 'Duplicate artwork');
  assert.equal(verifiedLaunchMetadata(ambiguous.artifact).icon, undefined);
  const unsupported = await release(35129, [['x', hash(html)], ['icon', hash(png), 'image/svg+xml']], 'Unsupported artwork');
  assert.equal(verifiedLaunchMetadata(unsupported.artifact).icon, undefined);
});

test('legacy descriptions and snapshot references preserve the signed publication identity', async () => {
  const legacy = await release(35129, [['path', '/index.html', hash(html)], ['description', 'Legacy description']], 'Not the legacy description');
  assert.equal(verifiedLaunchMetadata(legacy.artifact).description, 'Legacy description');
  const snapshot = await release(5129, [['x', hash(html)]], 'Snapshot description');
  assert.equal(verifiedLaunchMetadata(snapshot.artifact).reference, snapshot.reference);
  assert.equal(verifiedLaunchMetadata(snapshot.artifact).title, 'Published snapshot');
});

test('launch artwork reuses bounded verified Blossom bytes and rejects mismatched raster formats or cancellation', async () => {
  const fallback = 'https://mirror.example.org/';
  const requests: unknown[] = [];
  const media = createLaunchReviewMedia({ async readProfile() { return null; } },
    async () => assert.fail('Icon read must not fetch a profile avatar'),
    { async readHtml(hash, mirrors, maxBytes, signal) {
      requests.push({ hash, mirrors, maxBytes, signal });
      return png;
    } }, () => [server, fallback]);
  const controller = new AbortController();
  const icon = { hash: hash(png), serverHints: [server], mime: 'image/png' };
  assert.equal(await media.readIcon(icon, controller.signal), 'data:image/png;base64,' + png.toString('base64'));
  assert.deepEqual(requests, [{ hash: hash(png), mirrors: [server, fallback], maxBytes: 768 * 1024, signal: controller.signal }]);
  await assert.rejects(media.readIcon({ ...icon, mime: 'image/jpeg' }, controller.signal));
  controller.abort();
  await assert.rejects(media.readIcon(icon, controller.signal));
});
