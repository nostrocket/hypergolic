import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { NappletLinkError, resolveNappletLink } from '../../src/napplets/resolve-link.ts';
import {
  MAX_HTML_BYTES, MAX_MANIFEST_BYTES, NappletVerificationError, verifyArtifact, verifyManifest,
} from '../../src/napplets/verified-artifact.ts';

const SECRET = new Uint8Array(32); SECRET[31] = 2;
const PUBKEY = getPublicKey(SECRET);
const HTML = new TextEncoder().encode('<!doctype html><html><head><title>Test</title></head><body><main>ok</main></body></html>');
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
async function fixtureTags(options: { x?: boolean; html?: Uint8Array; extras?: string[][] } = {}): Promise<string[][]> {
  const htmlHash = await sha(options.html ?? HTML);
  const aggregateHash = await sha(new TextEncoder().encode(`${htmlHash} /index.html\n`));
  return [
    ['d', 'hello'], ['path', '/index.html', htmlHash],
    ...(options.x === false ? [] : [['x', aggregateHash, 'aggregate']]),
    ['server', 'https://blossom.example.org'], ['requires', 'theme'], ...(options.extras ?? []),
  ];
}
function signed(tags: string[][], overrides: Record<string, unknown> = {}): any {
  const base = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '', tags, ...overrides } as any, SECRET);
  return JSON.parse(JSON.stringify(base));
}
const LINK = naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'hello', relays: ['wss://relay.example.org'] });
const coordinate = () => resolveNappletLink(`nostr:${LINK}`);
const rejects = async (operation: () => unknown | Promise<unknown>) => assert.rejects(operation, NappletVerificationError);

test('resolves lowercase naddr and nostr:naddr with validated non-authoritative hints', () => {
  assert.deepEqual(resolveNappletLink(LINK), {
    kind: 35129, pubkey: PUBKEY, identifier: 'hello', relayHints: ['wss://relay.example.org'],
  });
  assert.equal(Object.isFrozen(resolveNappletLink(LINK)), true);
  assert.equal(Object.isFrozen(resolveNappletLink(LINK).relayHints), true);
});

test('accepts valid naddr TLV ordering from a published external napplet', () => {
  const link = 'naddr1qqxkutf4xfnrjefjxfnr2cm9qyg8wumn8ghj7mn0wd68ytnddakj7q3q82jczunncwe0jn6frpqwq3e0qjws7yqqnc3auccqv9nte2dnd63sxpqqqzynjnnn6hl';
  assert.deepEqual(resolveNappletLink(link), {
    kind: 35129,
    pubkey: '3aa5817273c3b2f94f491840e0472f049d0f10009e23de63006166bca9b36ea3',
    identifier: 'n-52f9e22f5ce',
    relayHints: ['wss://nostr.mom/'],
  });
});

test('rejects wrong-kind, malformed and non-public relay coordinates', () => {
  for (const input of [
    '', `nostr:${LINK.toUpperCase()}`,
    'naddr1' + 'q'.repeat(8192),
    naddrEncode({ kind: 35128, pubkey: PUBKEY, identifier: 'hello' }),
    naddrEncode({ kind: 1, pubkey: PUBKEY, identifier: 'hello' }),
    naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: '' }),
    naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: ' hello' }),
    naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'hello\u0000' }),
    `${LINK.slice(0, -1)}q`,
    naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'hello', relays: ['ws://relay.example.org'] }),
    naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'hello', relays: ['wss://127.0.0.1'] }),
  ]) assert.throws(() => resolveNappletLink(input), NappletLinkError);
});

test('verifies signed manifest, recomputes optional aggregate, and returns frozen version identity', async () => {
  for (const includeX of [true, false]) {
    const event = signed(await fixtureTags({ x: includeX }));
    const manifest = await verifyManifest(coordinate(), event);
    assert.equal(manifest.id, event.id); assert.equal(manifest.eventId, event.id);
    assert.equal(manifest.versionId, manifest.aggregateHash);
    assert.equal(manifest.expectedHtmlHash, await sha(HTML));
    assert.equal(Object.isFrozen(manifest), true); assert.equal(Object.isFrozen(manifest.tags), true);
    assert.equal(manifest.serverHints[0], 'https://blossom.example.org/');
    assert.deepEqual(manifest.requiredDomains, ['theme']);
    const source = new Uint8Array(HTML);
    const artifact = await verifyArtifact(manifest, source);
    const firstRead = artifact.htmlBytes;
    assert.equal(artifact.htmlHash, manifest.expectedHtmlHash);
    assert.equal(artifact.aggregateHash, manifest.aggregateHash);
    assert.notEqual(firstRead, source);
    assert.deepEqual(firstRead, source);
    assert.equal(Object.isFrozen(artifact), true);
    firstRead[0] = 0;
    assert.notEqual(artifact.htmlBytes, firstRead);
    assert.deepEqual(artifact.htmlBytes, HTML);
    assert.equal(artifact.htmlHash, await sha(HTML));
    source[0] = 0;
    assert.deepEqual(artifact.htmlBytes, HTML);
  }
});

test('rejects wrong kind, publisher, d coordinate, event id, signature and claimed aggregate', async () => {
  const good = signed(await fixtureTags());
  const other = naddrEncode({ kind: 35129, pubkey: '22'.repeat(32), identifier: 'hello' });
  const wrongD = naddrEncode({ kind: 35129, pubkey: PUBKEY, identifier: 'other' });
  const wrongKind = { ...good, kind: 35128 };
  for (const event of [
    wrongKind, { ...good, pubkey: '22'.repeat(32) }, { ...good, tags: good.tags.map((tag: string[]) => tag[0] === 'd' ? ['d', 'other'] : tag) },
    { ...good, id: '00'.repeat(32) }, { ...good, sig: '00'.repeat(64) },
  ]) await rejects(() => verifyManifest(coordinate(), event));
  await rejects(() => verifyManifest(resolveNappletLink(other), good));
  await rejects(() => verifyManifest(resolveNappletLink(wrongD), good));
  const wrongAggregate = signed(await fixtureTags({ extras: [['x', '00'.repeat(32), 'aggregate']] }));
  await rejects(() => verifyManifest(coordinate(), wrongAggregate));
});

test('ignores verification cache symbols and independently verifies cloned signed fields', async () => {
  const event = await fixtureTags();
  const cached = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '', tags: event }, SECRET);
  assert.equal(Object.getOwnPropertySymbols(cached).length, 1);
  assert.equal((await verifyManifest(coordinate(), cached)).pubkey, PUBKEY);
  const forged = { ...cached, sig: '00'.repeat(64) };
  await rejects(() => verifyManifest(coordinate(), forged));
});

test('rejects duplicate required tags, wrong path, malformed server hints and malformed domains', async () => {
  const base = await fixtureTags();
  const duplicateD = signed([...base, ['d', 'hello']]);
  const duplicatePath = signed([...base, ['path', '/index.html', '00'.repeat(32)]]);
  const badPath = signed(base.map(tag => tag[0] === 'path' ? ['path', '/other.html', tag[2]!] : tag));
  const badServer = signed(base.map(tag => tag[0] === 'server' ? ['server', 'http://127.0.0.1/'] : tag));
  const badDomain = signed(base.map(tag => tag[0] === 'requires' ? ['requires', 'NAP-THEME'] : tag));
  for (const event of [duplicateD, duplicatePath, badPath, badServer, badDomain]) await rejects(() => verifyManifest(coordinate(), event));
});

test('rejects exotic objects/accessors and oversized manifest without executing getters', async () => {
  const good = signed(await fixtureTags());
  let reads = 0;
  const accessorTags = [...good.tags];
  Object.defineProperty(accessorTags, '0', { get() { reads++; return good.tags[0]; }, configurable: true });
  await rejects(() => verifyManifest(coordinate(), { ...good, tags: accessorTags }));
  assert.equal(reads, 0);
  const extra = { ...good, extra: true };
  await rejects(() => verifyManifest(coordinate(), extra));
  const huge = signed(await fixtureTags(), { content: 'x'.repeat(MAX_MANIFEST_BYTES) });
  await rejects(() => verifyManifest(coordinate(), huge));
});

test('rejects malformed UTF-8/HTML, mismatched hashes and oversized blobs before returning bytes', async () => {
  const manifest = await verifyManifest(coordinate(), signed(await fixtureTags()));
  await rejects(() => verifyArtifact(manifest, new Uint8Array([0xff, 0xfe])));
  await rejects(() => verifyArtifact(manifest, new TextEncoder().encode('<html><body>truncated')));
  await rejects(() => verifyArtifact(manifest, new TextEncoder().encode('<!doctype html><html><head></head><body>wrong</body></html>')));
  await rejects(() => verifyArtifact(manifest, new Uint8Array(MAX_HTML_BYTES + 1)));
});

test('rejects an unregistered lookalike manifest at the artifact verification boundary', async () => {
  const verified = await verifyManifest(coordinate(), signed(await fixtureTags()));
  await rejects(() => verifyArtifact({ ...verified }, HTML));
});

test('accepts a balanced document containing raw-text script source and rejects broken nesting', async () => {
  const html = new TextEncoder().encode('<!doctype html><html><head><script>const x = "<tag>";</script></head><body><p>ok</p></body></html>');
  const manifest = await verifyManifest(coordinate(), signed(await fixtureTags({ html })));
  assert.equal((await verifyArtifact(manifest, html)).htmlHash, manifest.expectedHtmlHash);
  const malformed = new TextEncoder().encode('<!doctype html><html><head></head><body><main></body></main></html>');
  const badManifest = await verifyManifest(coordinate(), signed(await fixtureTags({ html: malformed })));
  await rejects(() => verifyArtifact(badManifest, malformed));
  const beforeHead = new TextEncoder().encode('<!doctype html><html><script>window.executed = true</script><head></head><body>unsafe order</body></html>');
  const beforeHeadManifest = await verifyManifest(coordinate(), signed(await fixtureTags({ html: beforeHead })));
  await rejects(() => verifyArtifact(beforeHeadManifest, beforeHead));
});

test('rejects a duplicate optional x tag and requires any included x to match', async () => {
  const base = await fixtureTags();
  await rejects(() => verifyManifest(coordinate(), signed([...base, ...base.filter(tag => tag[0] === 'x')])));
  const noX = base.filter(tag => tag[0] !== 'x');
  const validNoX = await verifyManifest(coordinate(), signed(noX));
  await rejects(() => verifyArtifact(validNoX, new TextEncoder().encode('<!doctype html><html><head></head><body>tampered</body></html>')));
});
