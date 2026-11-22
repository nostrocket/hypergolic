import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {observeIdentity} from './host.mjs';
import {createKeysSession} from '../../runtime/src/keys-adapter.ts';
import {projectMediaRequest} from '../../runtime/src/media-wire.ts';
import {componentCases, runComponent} from './component-cases.mjs';
import { verifiedLaunchMetadata } from '../../src/napplets/verified-launch-metadata.ts';
import { verifyManifest, verifyArtifact, NappletVerificationError } from '../../src/napplets/verified-artifact.ts';
import { createRelaySubscriptions } from '../../src/network/relay-subscriptions.ts';
import { parseRoutingMessage, RoutingRequestError } from '../../src/routing/routing-contract.ts';
import { setup as configHarness } from '../../tests/presentation/config-harness.ts';

const key = generateSecretKey();
const html = new TextEncoder().encode('<!doctype html><html><head></head><body>Conformance</body></html>');
const hash = createHash('sha256').update(html).digest('hex');
const d = 'protocol-fixture';

function manifest(tags, content) {
  const event = finalizeEvent({kind:35129, created_at:1, tags:[['d', d], ...tags], content}, key);
  return verifyManifest({kind:35129, pubkey:event.pubkey, identifier:d}, JSON.parse(JSON.stringify(event)));
}

async function rejectsVerification(work) {
  try { await work(); }
  catch (error) {
    if (error instanceof NappletVerificationError) return true;
    throw error;
  }
  return false;
}

async function configuration(save) {
  const cleanup = [];
  const harness = await configHarness({after: callback => cleanup.push(callback)});
  const schema = value => ({type:'object', properties:{theme:{type:'string', default:value}}});
  try {
    await harness.register(schema('dark'));
    assert.equal((await harness.get()).theme, 'dark', 'Initial config fixture did not register');
    if (save) {
      await harness.broker.open(harness.source.generation);
      await harness.broker.commit(harness.broker.getSnapshot().review.id, {theme:'dark'}, {});
    }
    await harness.register(schema('light'), 2);
    return (await harness.get()).theme;
  } finally {
    for (const action of cleanup.reverse()) await action();
  }
}

function streamContinuity() {
  let receive;
  const port = {newInstanceId:randomUUID, open(_id, _url, _wire, sub, deliver) {
    receive = event => deliver(JSON.stringify(['EVENT', sub, event]));
    return () => { receive = undefined; };
  }};
  const subscriptions = createRelaySubscriptions(port, () => ['wss://relay.example.org']);
  const registration = {sessionId:d, generation:d, instanceId:d, epoch:0, user:'1'.repeat(64), publisher:'2'.repeat(64),
    version:'3'.repeat(64), appId:'feed-lab', fixture:'feed-lab', domains:['relay']};
  const session = subscriptions.session({registration, assertActive() {}});
  const event = (kind, content) => finalizeEvent({kind, content, tags:[], created_at:1}, key);
  const first = event(1, 'first');
  const last = event(1, 'last');
  const messages = [];
  try {
    session.subscribe({type:'relay.subscribe', id:d, subId:d, filters:[{authors:[first.pubkey]}]}, m => { messages.push(m); return true; });
    receive(first);
    assert.ok(messages.some(m => m.result?.event.id === first.id), 'Public subscription control failed');
    receive(event(4, 'unused private-event fixture'));
    receive?.(last);
    return messages.length === 2 && messages[0].result?.event.id === first.id && messages[1].result?.event.id === last.id;
  } finally { session.revoke(); }
}

async function themeQuotaReply() {
  // Use the host's own bundler to resolve the same TypeScript entry point as the shipped runtime.
  const runtime = new URL('../../runtime/', import.meta.url);
  const vite = await import(createRequire(new URL('package.json', runtime)).resolve('vite'));
  const server = await vite.createServer({root:fileURLToPath(runtime), configFile:false, logLevel:'error',
    server:{middlewareMode:true, hmr:false, watch:null}, optimizeDeps:{noDiscovery:true}});
  try {
    const {quotaReply} = await server.ssrLoadModule('/src/guest-envelope.ts');
    const reply = quotaReply({type:'theme.get', id:d}, ['theme']);
    return reply?.type === 'theme.get.result' && reply.id === d && typeof reply.error === 'string';
  } finally { await server.close(); }
}

export const observations = {
  ...Object.fromEntries(componentCases.map(([id, , file, name]) => [id, () => runComponent(file, name)])),
  'keys-registration': () => {
    const sent = [];
    const session = createKeysSession({postMessage:message => sent.push(message)}, () => true);
    session.receive({type:'keys.registerAction', id:'request', action:{id:'search', label:'Search'}});
    return sent.some(m => m.type === 'keys.registerAction.result' && m.id === 'request' && m.actionId === 'search' && !m.error);
  },
  'media-destroy': () => {
    const sessionId = 'media-' + randomUUID();
    const result = projectMediaRequest({type:'media.session.destroy', sessionId});
    return result?.type === 'media.session.destroy' && result.sessionId === sessionId;
  },
  'modern-manifest': async () => (await verifyArtifact(await manifest([['x', hash]], 'A fixture'), html)).htmlHash === hash,
  'artifact-integrity': () => rejectsVerification(async () => verifyArtifact(await manifest([['x', hash]], 'A fixture'), new Uint8Array([0]))),
  'legacy-manifest': () => rejectsVerification(() => manifest([['path', '/index.html', hash]], 'A fixture')),
  'launch-icon-format': async () => {
    const artifact = await verifyArtifact(await manifest([['x', hash], ['icon', hash, 'image/gif']], 'A fixture'), html);
    return verifiedLaunchMetadata(artifact).icon === undefined;
  },
  'inc-peer': () => runComponent('routing/inc', 'Topic sender IDs distinguish publishers and instances and expire on replacement'),
  'relay-continuity': streamContinuity,
  'config-default': async () => await configuration(false) === 'light',
  'config-user-choice': async () => await configuration(true) === 'dark',
  'identity-connected': observeIdentity,
  'intent-action': () => {
    const request = {archetype:'feed', convention:'napplet:feed/open'};
    const wire = fields => ({type:'intent.invoke', id:d, request:fields});
    assert.equal(parseRoutingMessage(wire({...request, action:'open'})).request.action, 'open');
    try { parseRoutingMessage(wire(request)); }
    catch (error) { if (error instanceof RoutingRequestError) return true; throw error; }
    return false;
  },
  'theme-reply': themeQuotaReply,
};
