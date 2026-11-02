import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { loadEmbeddedTestArtifact } from '../../src/napplets/embedded-test-fixture.ts';
import { requestFirstOpenConsent } from '../../src/napplets/first-open-consent.ts';
import { descriptorForPublishedArtifact, publishedHostInput } from '../../src/napplets/published-host-input.ts';
import { verifyArtifact, verifyManifest } from '../../src/napplets/verified-artifact.ts';
import { registration, setup } from '../storage/harness.ts';

const USER = '21'.repeat(32);
const SESSION = '58274370-ec8f-4058-a4cc-b63e7e75ca4b';

test('a signed artifact and current consent bind the exact publisher, version and capabilities to the native claim', async t => {
  const { database } = await setup(t);
  const artifact = await loadEmbeddedTestArtifact();
  const descriptor = descriptorForPublishedArtifact(artifact, SESSION);
  assert.equal(descriptor.source, 'published');
  assert.equal(descriptor.eventId, artifact.manifest.eventId);
  const owner = registration({ user: USER, publisher: descriptor.publisher, appId: descriptor.appId });
  const admission = await requestFirstOpenConsent(artifact, owner, database.bindApp(owner).port,
    new AbortController().signal, owner.assertActive, async () => true);
  const authority = { user: USER, epoch: 7, assertActive: () => undefined };
  const input = JSON.parse(publishedHostInput(artifact, admission, descriptor, authority, 'a'.repeat(64)));
  assert.deepEqual(Object.keys(input).sort(), ['sessionId', 'publisher', 'appId', 'eventId', 'version', 'htmlHash', 'handle', 'configuration'].sort());
  assert.deepEqual(JSON.parse(input.configuration), {
    sessionId: SESSION, epoch: 7, user: USER, publisher: descriptor.publisher,
    appId: descriptor.appId, version: descriptor.version, instanceId: SESSION,
    fixture: 'published', domains: ['theme'],
  });
});

test('stale identity, denied or forged consent and substituted descriptor cannot prepare a native host', async t => {
  const { database } = await setup(t);
  const artifact = await loadEmbeddedTestArtifact();
  const descriptor = descriptorForPublishedArtifact(artifact, SESSION);
  const live = { value: true };
  const owner = registration({ user: USER, publisher: descriptor.publisher, appId: descriptor.appId,
    assertActive: () => { if (!live.value) throw new Error('revoked'); } });
  const storage = database.bindApp(owner).port;
  await assert.rejects(requestFirstOpenConsent(artifact, owner, storage, new AbortController().signal,
    owner.assertActive, async () => false));
  const admission = await requestFirstOpenConsent(artifact, owner, storage, new AbortController().signal,
    owner.assertActive, async () => true);
  const authority = { user: USER, epoch: 0, assertActive: owner.assertActive };
  const prepare = (changed = descriptor, token: unknown = admission) => publishedHostInput(artifact, token, changed,
    authority, 'a'.repeat(64));
  assert.throws(() => prepare({ ...descriptor, eventId: 'f'.repeat(64) }));
  assert.throws(() => prepare({ ...descriptor, publisher: 'f'.repeat(64) }));
  assert.throws(() => prepare({ ...descriptor, version: 'f'.repeat(64) }));
  assert.throws(() => prepare(descriptor, { ...admission }));
  assert.throws(() => publishedHostInput(artifact, admission, descriptor, authority, '../path'));
  live.value = false;
  assert.throws(() => prepare());
});

test('unknown required NAP domains do not prevent a verified descriptor', async () => {
  const secret = new Uint8Array(32); secret[31] = 34;
  const publisher = getPublicKey(secret);
  const bytes = new TextEncoder().encode('<!doctype html><html><head><title>Unknown</title></head><body>ok</body></html>');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const aggregate = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hash} /index.html\n`))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const event = finalizeEvent({ kind: 35129, created_at: 1_800_000_000, content: '', tags: [
    ['d', 'future-domain'], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'], ['requires', 'future-domain'],
  ] }, secret);
  const coordinate = { kind: 35129 as const, pubkey: publisher, identifier: 'future-domain', relayHints: [] };
  const artifact = await verifyArtifact(await verifyManifest(coordinate, JSON.parse(JSON.stringify(event))), bytes);
  assert.equal(descriptorForPublishedArtifact(artifact, SESSION).appId, 'future-domain');
});


test('verified resource/upload grants and the complete selected domain set survive published native input', async t => {
  const { database } = await setup(t);
  const bytes = new TextEncoder().encode('<!doctype html><html><head><title>Selected</title></head><body>ok</body></html>');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const aggregate = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hash} /index.html\n`))), byte => byte.toString(16).padStart(2, '0')).join('');
  const secret = new Uint8Array(32); secret[31] = 35;
  for (const domains of [['resource'], ['upload'], ['identity','storage','theme','relay','resource','upload']]) {
    const appId = 'selected-' + domains.join('-');
    const event = finalizeEvent({kind: 35129, created_at: 1_800_000_000, content: '', tags: [
      ['d', appId], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'], ...domains.map(domain => ['requires', domain]),
    ]}, secret);
    const artifact = await verifyArtifact(await verifyManifest({kind: 35129, pubkey: event.pubkey, identifier: appId, relayHints: []}, JSON.parse(JSON.stringify(event))), bytes);
    const descriptor = descriptorForPublishedArtifact(artifact, SESSION);
    const owner = registration({user: USER, publisher: event.pubkey, appId});
    const control = database.bindApp(owner);
    await assert.rejects(requestFirstOpenConsent(artifact, owner, control.port, new AbortController().signal, owner.assertActive, async () => false));
    assert.equal(await control.port.readAccessGrant(), null);
    const admission = await requestFirstOpenConsent(artifact, owner, control.port, new AbortController().signal, owner.assertActive, async request => {
      assert.deepEqual(request.domains, [...domains].sort()); return true;
    });
    const wire = JSON.parse(publishedHostInput(artifact, admission, descriptor, {user: USER, epoch: 1, assertActive: owner.assertActive}, 'a'.repeat(64)));
    assert.deepEqual(JSON.parse(wire.configuration).domains, [...domains].sort());
    assert.equal(JSON.parse(wire.configuration).fixture, 'published');
    assert.equal(wire.publisher, event.pubkey);
    control.revoke();
  }
});


test('a verified Outbox manifest carries its exact approved publisher/version/relay grant to the native host', async t => {
  const {database} = await setup(t); const secret = new Uint8Array(32); secret[31] = 35;
  const pub = getPublicKey(secret), bytes = new TextEncoder().encode('<!doctype html><html><head><title>Outbox</title></head><body>outbox admission</body></html>');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  const aggregate = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hash} /index.html\n`))), x => x.toString(16).padStart(2, '0')).join('');
  const event = JSON.parse(JSON.stringify(finalizeEvent({kind: 35129, created_at: 1_800_000_000, content: '', tags: [
    ['d', 'outbox-admission'], ['path', '/index.html', hash], ['x', aggregate, 'aggregate'],
    ['requires', 'outbox'], ['requires', 'relay'], ['requires', 'theme'], ['requires', 'fs'],
  ]}, secret)));
  const coordinate = {kind: 35129, pubkey: pub, identifier: 'outbox-admission', relays: []};
  const artifact = await verifyArtifact(await verifyManifest(coordinate, event), bytes);
  const descriptor = descriptorForPublishedArtifact(artifact, SESSION);
  const live = {value: true}, owner = registration({user: USER, publisher: pub, appId: descriptor.appId,
    assertActive: () => {if (!live.value) throw Error('revoked');}});
  const admission = await requestFirstOpenConsent(artifact, owner, database.bindApp(owner).port, new AbortController().signal, owner.assertActive,
    async request => {assert.deepEqual(request.unsupportedDomains, ['fs']); return true;});
  const authority = {user: USER, epoch: 9, assertActive: owner.assertActive};
  const prepared = JSON.parse(publishedHostInput(artifact, admission, descriptor, authority, 'a'.repeat(64)));
  const config = JSON.parse(prepared.configuration);
  assert.deepEqual(config.domains, ['outbox', 'relay', 'theme']); assert.equal(config.publisher, pub);
  assert.equal(config.version, aggregate); assert.equal(config.fixture, 'published'); assert.equal(config.epoch, 9);
  assert.throws(() => publishedHostInput(artifact, {...admission}, descriptor, authority, 'a'.repeat(64)));
  assert.throws(() => publishedHostInput(artifact, admission, {...descriptor, version: 'f'.repeat(64)}, authority, 'a'.repeat(64)));
  live.value = false; assert.throws(() => publishedHostInput(artifact, admission, descriptor, authority, 'a'.repeat(64)));
});


test('the WK published Outbox fixture verifies through the owning manifest and exact-artifact verifier', async () => {
  const event = JSON.parse(await readFile(new URL('../native/ios-boundary/Fixtures/published-outbox-manifest.json', import.meta.url), 'utf8'));
  const bytes = new Uint8Array(await readFile(new URL('../../runtime/fixtures/ux-lab.html', import.meta.url)));
  const coordinate = {kind: 35129, pubkey: event.pubkey, identifier: 'outbox-native-test', relays: []};
  const manifest = await verifyManifest(coordinate, event);
  const artifact = await verifyArtifact(manifest, bytes);
  assert.deepEqual(artifact.manifest.requiredDomains, ['outbox', 'relay', 'theme']);
  assert.equal(artifact.manifest.eventId, event.id);
  await assert.rejects(verifyManifest(coordinate, {...event, sig: '0'.repeat(128)}));
  const changed = bytes.slice(); changed[0] ^= 1;
  await assert.rejects(verifyArtifact(manifest, changed));
});
