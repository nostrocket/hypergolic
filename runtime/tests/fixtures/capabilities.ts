import { createUploadAdapter } from '../../src/upload-adapter';
import { createNativeClient } from '../../src/native-client';
import { createShellBridge, injectNappletNamespacePrelude, originRegistry,
  resolveShellEnvironment, renderNappletNamespacePrelude, type ShellAdapter } from '@kehto/shell';
import type { HostOperationContext, HostOperation, HostOperationEnvelope } from '@kehto/runtime';
import { createThemeService } from '@kehto/services';

// Test-only trusted host. No device bridge, key, signer or network transport is installed.
const selected = new URLSearchParams(location.search);
const state = { calls: [] as { windowId: string; message: HostOperationEnvelope }[],
  audit: [] as string[], signerReads: 0, legacyRelayCalls: 0, deniedAdapters: [] as string[],
  incoming: [] as unknown[], holdReady: selected.has('holdReady') };
const pending: HostOperationContext[] = [];
const store = new Map<string, string>();
const record = (label: string): void => { state.deniedAdapters.push(label); };
const fail = (label: string): never => { record(label); throw new Error('Test-only unavailable adapter'); };
const noSubscription = (): void => record('subscription-cleanup');
const operations: HostOperation[] = ['storage.get', 'storage.set', 'storage.remove', 'storage.keys',
  'relay.publish', 'relay.publishEncrypted', 'relay.query', 'relay.subscribe', 'relay.close', ...(selected.has('outbox') ? ['outbox.publish' as const,'outbox.query' as const,'outbox.getEvent' as const,'outbox.resolveRelays' as const,'outbox.subscribe' as const,'outbox.close' as const] : [])];
const testOperation = (context: HostOperationContext): void | Promise<void> => {
  const { windowId, message, send } = context;
  state.calls.push({ windowId, message });
  state.audit.push(`operation:${message.type}`);
  const msg = message as unknown as Record<string, unknown>;
  if (msg.key === 'reject') return Promise.reject(new Error('Do not expose rejection'));
  if (msg.key === 'throw') throw new Error('Do not expose this exception');
  if (selected.has('defer')) { pending.push(context); return; }
  if (message.type === 'storage.set') {
    store.set(String(msg.key), String(msg.value));
    send({ type: 'storage.set.result', id: String(msg.id) });
  } else if (message.type === 'storage.get') {
    send({ type: 'storage.get.result', id: String(msg.id), value: store.get(String(msg.key)) ?? null });
  } else if (message.type === 'storage.remove') {
    store.delete(String(msg.key));
    send({ type: 'storage.remove.result', id: String(msg.id) });
  } else if (message.type === 'storage.keys') {
    send({ type: 'storage.keys.result', id: String(msg.id), keys: [...store.keys()] });
  } else if(message.type==='outbox.getEvent'){send({type:'outbox.getEvent.result',id:message.id,error:'not found'});
  } else if(message.type==='outbox.resolveRelays'){send({type:'outbox.resolveRelays.result',id:message.id,plan:{relays:['wss://nos.lol'],source:'cache'}});
  } else if(message.type==='outbox.subscribe'||message.type==='outbox.close'){send({type:'outbox.closed',subId:message.subId,reason:'test-only closed'});
  } else if (message.type === 'relay.query' || message.type === 'outbox.query') {
    send({ type: `${message.type}.result`, id: String(msg.id), events: [] });
  } else if (message.type === 'relay.subscribe' || message.type === 'relay.close') {
    send({ type: 'relay.closed', subId: String(msg.subId), reason: 'test-only closed' });
  } else {
    send({ type: `${message.type}.result`, id: String(msg.id), ok: false, error: 'test-only declined' } as HostOperationEnvelope);
  }
};
const theme = createThemeService({ initialTheme: { colors: { background: '#140f0b', text: '#f3efeb', primary: '#e8805d' } } });
const domains = selected.has('noRelay') ? ['theme', 'storage'] : ['theme', 'storage', 'relay'];
if (selected.has('upload')) domains.push('upload');
if (selected.has('outbox')) domains.push('outbox');
const hooks: ShellAdapter = {
  relayPool: { getRelayPool: () => null, trackSubscription: () => fail('track'),
    untrackSubscription: noSubscription, openScopedRelay: () => fail('open'),
    closeScopedRelay: noSubscription, publishToScopedRelay: () => { record('publish'); return false; },
    selectRelayTier: () => [] },
  relayConfig: { addRelay: () => fail('addRelay'), removeRelay: () => fail('removeRelay'),
    getRelayConfig: () => ({ discovery: [], super: [], outbox: [] }), getNip66Suggestions: () => null },
  windowManager: { createWindow: () => null },
  auth: { getUserPubkey: () => null, getSigner: () => { state.signerReads++; return null; } },
  config: { getNappUpdateBehavior: () => 'banner' }, hotkeys: { executeHotkeyFromForward: () => fail('hotkey') },
  workerRelay: { getWorkerRelay: () => null }, crypto: { verifyEvent: async () => false },
  services: { theme: theme.handler, ...(selected.has('outbox') ? {outbox: {descriptor: {name: 'outbox', version: 'test-only'}, handleMessage: () => {throw new Error('Builtin Outbox service must not run');}}} : {}), ...(selected.has('upload') ? {upload: {descriptor: {name: 'upload', version: 'test-only'}, handleMessage: () => {throw new Error('Builtin upload service must not run');}}} : {}), relay: { descriptor: { name: 'relay', version: 'test-only' }, handleMessage: () => { state.legacyRelayCalls++; throw new Error('Existing relay service called'); } } },
  onAclCheck: event => state.audit.push(`acl:${event.capability}:${event.decision}`),
  capabilities: { disabledDomains: ['identity', 'inc', 'keys', 'media', 'notify'],
    resolveEnvironment: () => ({ domains, services: ['theme'] }) },
  ...(selected.has('noHook') ? {} : { operationOverrides: {...Object.fromEntries(operations.map(type => [type, testOperation])), ...(selected.has('upload') ? {
    'upload.info': (context: HostOperationContext) => uploadAdapter(context), 'upload.upload': (context: HostOperationContext) => uploadAdapter(context), 'upload.status': (context: HostOperationContext) => uploadAdapter(context),
  } : {})} }),
};
const bridge = createShellBridge(hooks);
const identity = { dTag: 'test-only-capability-lab', aggregateHash: 'a'.repeat(64) };
const environment = resolveShellEnvironment(hooks, identity);
const frame = document.createElement('iframe');
frame.id = 'napplet'; frame.sandbox.add('allow-scripts'); frame.title = 'Test-only capability fixture';
document.body.append(frame);
const source = frame.contentWindow;
if (!source) throw new Error('No frame window');
originRegistry.register(source, 'native-owned-test-session', identity);
originRegistry.setEnvironment(source, environment);
const evaluateFirewall = bridge.runtime.firewallState.evaluate;
bridge.runtime.firewallState.evaluate = observation => {
  const result = evaluateFirewall(observation);
  state.audit.push(`firewall:${result.decision}`);
  return result;
};
const receive = (event: MessageEvent): void => {
  state.incoming.push(event.data);
  if (!event.isTrusted || event.source !== source) return;
  if (state.holdReady && event.data?.type === 'shell.ready') return;
  bridge.handleMessage(event);
};
window.addEventListener('message', receive);
const fixture = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; connect-src \'none\'; frame-src \'none\'; base-uri \'none\'; form-action \'none\'"></head><body><script>window.received=[];addEventListener("message",e=>received.push(e.data));window.napplet.shell.ready().then(()=>document.body.dataset.ready="true");</script></body></html>';
frame.srcdoc = injectNappletNamespacePrelude(fixture, { domains: environment.capabilities.domains,
  ...(selected.has('longTimeout') ? { requestTimeoutsMs: { 'relay.publish': 660_000 } } : {}) });
const uploadState = {mode: 'normal', requests: [] as Record<string, unknown>[], body: [] as number[],
  seal: null as {sequence: number; uploadId: string; delivery: number} | null};
const uploadListeners = new Set<(event: {data: unknown}) => void>();
const privateToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publicUploadId = 'public-upload-one';
const nativeUpload = createNativeClient({
  addEventListener: (_type, listener) => {uploadListeners.add(listener);},
  removeEventListener: (_type, listener) => {uploadListeners.delete(listener);},
  postMessage(raw) {
    const envelope = JSON.parse(raw);
    if (envelope.type !== 'capability') return;
    const request = JSON.parse(envelope.message); uploadState.requests.push(request);
    let response: Record<string, unknown> = {type: request.type + '.result', id: request.id};
    if (request.type === 'upload.__begin') {
      uploadState.body = []; response = {...response, token: privateToken, uploadId: publicUploadId};
      if (uploadState.mode === 'deny') response = {type: request.type + '.result', id: request.id, error: 'policy denied'};
    } else if (request.type === 'upload.__append') {
      const bytes = atob(request.base64);
      if (request.offset !== uploadState.body.length || request.token !== privateToken) throw new Error('Fixture cursor mismatch');
      for (const byte of bytes) uploadState.body.push(byte.charCodeAt(0));
      response.cursor = uploadState.body.length + (uploadState.mode === 'wrong-cursor' ? 1 : 0);
    } else if (request.type === 'upload.__seal') {
      uploadState.seal = {sequence: envelope.sequence, uploadId: publicUploadId, delivery: 0};
      response.result = {ok: true, uploadId: publicUploadId, status: 'pending', rail: 'blossom'};
    } else if (request.type === 'upload.info') response.info = {rails: [{rail: 'blossom', enabled: true}]};
    else if (request.type === 'upload.status') response.status = {ok: true, uploadId: publicUploadId, status: 'pending', rail: 'blossom'};
    const result = JSON.stringify({type: 'capability.result', sessionId: 'upload-test-generation', sequence: envelope.sequence, response: JSON.stringify(response)});
    queueMicrotask(() => {for (const listener of uploadListeners) listener({data: result});});
  },
}, 'upload-test-generation');
const uploadAdapter = createUploadAdapter(nativeUpload, () => {
  const captured = originRegistry.getRegistrationId(source);
  return () => captured !== undefined && originRegistry.getRegistrationId(source) === captured;
});
function uploadPush(status: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const seal = uploadState.seal; if (!seal) throw new Error('No fixture upload');
  const envelope = JSON.stringify({type: 'capability.upload', sessionId: 'upload-test-generation', sequence: seal.sequence,
    delivery: ++seal.delivery, response: JSON.stringify({type: 'upload.status.changed', status}), ...overrides});
  for (const listener of uploadListeners) listener({data: envelope});
}

const lab = {
  uploadState, uploadPush,
  state, hooks,
  block: () => bridge.runtime.aclState.block('', identity.dTag, identity.aggregateHash),
  firewall: (policy: 'deny' | 'ask' | 'allow') => bridge.runtime.firewallState.setPolicy(identity.dTag, policy),
  release: () => { for (const { message, send } of pending.splice(0)) {
    if (message.type === 'relay.publish') send({ type: 'relay.publish.result', id: String(message.id), ok: false, error: 'test-only declined' });
    else send({ type: 'storage.get.result', id: String(message.id), value: 'late test-only value' });
  } },
  unregister: () => { bridge.runtime.destroyWindow('native-owned-test-session'); bridge.runtime.sessionRegistry.unregister('native-owned-test-session'); originRegistry.unregister('native-owned-test-session'); },
  destroy: () => { bridge.destroy(); },
  replaceEntry: () => {
    const entry = bridge.runtime.sessionRegistry.getEntryByWindowId('native-owned-test-session');
    if (!entry) throw new Error('Session missing');
    bridge.runtime.sessionRegistry.register('native-owned-test-session', { ...entry });
  },
  render: renderNappletNamespacePrelude,
};
Object.assign(window, { lab });
