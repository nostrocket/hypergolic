import { installCloseCheck, CLOSE_CHECK_SERVICE } from './close-check';
import { ensureObjectHasOwn } from './legacy-webview';
import { injectSupportReport } from './support-report';
import {parseOutboxSubscribe,parseOutboxClose} from '../../src/outbox/subscription-contract';
import {createConfigAdapter} from './config-adapter';
import {parseConfigMessage} from '../../src/presentation/config-contract';
import {createNotifyAdapter} from './notify-adapter';
import {captureNotifyRejection, parseNotifyMessage} from '../../src/presentation/notify-contract';
import { createRoutingAdapter } from './routing-adapter';
import { parseRoutingMessage } from '../../src/routing/routing-contract';
import { createLinkAdapter } from './link-adapter';
import { linkRequestId } from '../../src/links/link-contract';
import { createUploadAdapter } from './upload-adapter';
import { parseUploadRequest } from '../../src/uploads/upload-contract';
import { bindResourceMedia, injectResourceMediaGate } from './resource-media';
import { createResourceAdapter } from './resource-adapter';
import { parseRelaySubscribe, parseRelayClose } from '../../src/network/relay-subscription-contract';
import {
  createShellBridge, injectNappletNamespacePrelude, originRegistry,
  resolveShellEnvironment, type ShellAdapter,
} from '@kehto/shell';
import type { ThemeService } from '@kehto/services';
import { createShellTheme } from './shell-theme';
import type { HostOperationContext, NappletMessage, ServiceRuntimeContext } from '@kehto/runtime';
import { identityFailure, identityResult, parseCapabilityRequest } from '../../src/runtime/capability-protocol';
import { createNativeClient, type NativeHost } from './native-client';
import { injectPublishedCsp, readPublishedArtifact } from './published-artifact';
import { ensureSecureRandomUuid } from './secure-random-compat';

type FailureCode = 'invalid-session' | 'bridge-unavailable' | 'fixture-integrity'
  | 'artifact-integrity' | 'runtime-bootstrap' | 'runtime-timeout' | 'frame-navigation';
type HostDiagnostic = { type: 'ready'; sessionId: string }
  | { type: 'error'; sessionId: string; code: FailureCode };
const hostWindow = window as Window & { HypergolicHost?: NativeHost };
const parameters = new URL(window.location.href).searchParams;
const sessionId = parameters.get('sessionId') ?? '';
const source = parameters.get('source');
const fixtureName = parameters.get('fixture') ?? 'ux-lab';
const fixture = source === null && Object.prototype.hasOwnProperty.call(__BUNDLED_FIXTURES__, fixtureName) ? __BUNDLED_FIXTURES__[fixtureName] : undefined;
type RuntimeArtifact = Readonly<{
  html: string; sha256: string; aggregateHash: string; appId: string; title: string;
  domains: readonly string[]; publishTimeoutMs?: number; published: boolean;
}>;
let stopped = false;
let cleanup: (() => void) | undefined;
window.addEventListener('pagehide', () => { stopped = true; cleanup?.(); }, { once: true });

function diagnostic(value: HostDiagnostic): void {
  const encoded = JSON.stringify(value);
  if (encoded.length > 2048) return;
  try { hostWindow.HypergolicHost?.postMessage(encoded); } catch { /* native teardown */ }
}
function fail(code: FailureCode): void {
  if (stopped) return;
  stopped = true;
  cleanup?.();
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'The napplet could not be loaded.';
  document.body.replaceChildren(message);
  diagnostic({ type: 'error', sessionId, code });
}

const csp = [
  "default-src 'none'", "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "frame-src 'none'",
  "media-src 'none'", "object-src 'none'", "manifest-src 'none'", "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Only fixed generated HTML whose bytes were independently verified is admitted. */
function injectCsp(html: string, policy: string): string {
  if (!/^<!doctype html>\s*<html lang="en">\s*<head>/i.test(html)) {
    throw new Error('Unexpected fixture structure');
  }
  return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function makeHooks(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean,
  artifact: RuntimeArtifact, theme: ThemeService, registerRouting: (context: ServiceRuntimeContext | null) => void): ShellAdapter {
  const unavailable = (): never => { throw new Error('Capability unavailable'); };
  const supported = new Set(artifact.domains);
  if (!supported.has('relay')) supported.delete('outbox');
  const routing = createRoutingAdapter(native, captureRecipient);
  const notify = createNotifyAdapter(native, captureRecipient);
  const config = createConfigAdapter(native, captureRecipient);
  const resource = createResourceAdapter(native, captureRecipient);
  const upload = createUploadAdapter(native, captureRecipient);
  const storage = async ({ message, send }: HostOperationContext): Promise<void> => { send({ ...await native.request(message) }); };
  const relayPublish = async ({ message, send }: HostOperationContext): Promise<void> => { send({ ...await native.request(message) }); };
  const relaySubscribe = ({message,send}:HostOperationContext):void => {
    const live=captureRecipient();
    try { native.subscribe(message,response=>{if(live())send({...response});}); }
    catch { if(live()){const outbox=message.type==='outbox.subscribe';const request=outbox?parseOutboxClose({type:'outbox.close',id:message.id,subId:message.subId}):parseRelayClose({type:'relay.close',id:message.id,subId:message.subId});send({type:outbox?'outbox.closed':'relay.closed',subId:request.subId,reason:'relay subscription unavailable'});} }
  };
  const relayClose = ({message}:HostOperationContext):void => { native.close(message); };
  const identity = { descriptor: { name: 'identity', version: '1.0.0' },
    handleMessage(_windowId: string, message: NappletMessage, send: (message: NappletMessage) => void): void {
      const live = captureRecipient();
      void native.request(message).then(response => { if (live()) send(response); }).catch(() => {
        if (!live()) return;
        try { const request = parseCapabilityRequest(message);
          send((request.type === 'identity.getPublicKey' ? identityResult(request, '') : identityFailure(request, 'identity request denied')) as NappletMessage);
        } catch { /* Unknown operation. */ }
      });
    } };
  return {
    relayPool: {
      getRelayPool: () => null, trackSubscription: unavailable,
      untrackSubscription: () => {}, openScopedRelay: unavailable,
      closeScopedRelay: () => {}, publishToScopedRelay: () => false,
      selectRelayTier: () => [],
    },
    relayConfig: { addRelay: unavailable, removeRelay: unavailable,
      getRelayConfig: () => ({ discovery: [], super: [], outbox: [] }),
      getNip66Suggestions: () => null },
    windowManager: { createWindow: () => null },
    auth: { getUserPubkey: () => null, getSigner: () => null },
    config: { getNappUpdateBehavior: () => 'banner' },
    hotkeys: { executeHotkeyFromForward: unavailable },
    workerRelay: { getWorkerRelay: () => null },
    crypto: { verifyEvent: async () => false },
    intent: {isAvailable: () => supported.has('intent')},
    link: {isAvailable: () => supported.has('link')},
    services: { theme: theme.handler,
      ...(supported.has('config') ? {config: {descriptor: {name: 'config', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('notify') ? {notify: {descriptor: {name: 'notify', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('intent') ? {intent: {descriptor: {name: 'intent', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('inc') ? {inc: {descriptor: {name: 'inc', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('link') ? {link: createLinkAdapter(native, captureRecipient)} : {}),
      ...(supported.has('upload') ? { upload: { descriptor: { name: 'upload', version: '1.0.0' }, handleMessage: unavailable } } : {}), ...(supported.has('identity') ? { identity } : {}),
      ...(supported.has('resource') ? { resource: { descriptor: { name: 'resource', version: '1.0.0' }, handleMessage: unavailable } } : {}),
      ...(supported.has('outbox') ? {outbox: {descriptor: {name: 'outbox', version: '1.0.0'}, handleMessage: unavailable}} : {}),
      ...(supported.has('relay') ? { relay: { descriptor: { name: 'relay', version: '1.0.0' }, handleMessage: unavailable } } : {}) },
    ...((supported.has('storage') || supported.has('relay') || supported.has('resource') || supported.has('upload') || supported.has('intent') || supported.has('inc') || supported.has('notify') || supported.has('config') || supported.has('outbox')) ? { operationOverrides: {
      ...(supported.has('config') ? {'config.registerSchema': config, 'config.get': config, 'config.subscribe': config, 'config.unsubscribe': config, 'config.openSettings': config} : {}),
      ...(supported.has('notify') ? {'notify.send': notify, 'notify.dismiss': notify, 'notify.badge': notify, 'notify.channel.register': notify, 'notify.permission.request': notify} : {}),
      ...(supported.has('intent') ? { 'intent.invoke': routing, 'intent.available': routing, 'intent.handlers': routing } : {}),
      ...(supported.has('inc') ? { 'inc.subscribe': routing, 'inc.unsubscribe': routing, 'inc.emit': routing, 'inc.channel.open': routing, 'inc.channel.list': routing, 'inc.channel.emit': routing, 'inc.channel.broadcast': routing, 'inc.channel.close': routing } : {}),
      ...(supported.has('upload') ? { 'upload.info': upload, 'upload.upload': upload, 'upload.status': upload } : {}),
      ...(supported.has('resource') ? { 'resource.info': resource, 'resource.bytes': resource, 'resource.bytesMany': resource, 'resource.cancel': resource } : {}),
      ...(supported.has('storage') ? { 'storage.get': storage, 'storage.set': storage, 'storage.remove': storage, 'storage.keys': storage } : {}),
      ...(supported.has('outbox') ? {'outbox.query': relayPublish, 'outbox.getEvent': relayPublish, 'outbox.resolveRelays': relayPublish, 'outbox.publish': relayPublish, 'outbox.subscribe': relaySubscribe, 'outbox.close': relayClose} : {}),
      ...(supported.has('relay') ? { 'relay.publish': relayPublish, 'relay.query': relayPublish, 'relay.subscribe': relaySubscribe, 'relay.close': relayClose } : {}),
    } } : {}),
    capabilities: {
      disabledDomains: ['link', 'upload', 'resource', 'relay', 'identity', 'storage', 'intent', 'inc', 'keys', 'media', 'notify', 'config', 'outbox'].filter(domain => !supported.has(domain)),
      resolveEnvironment: () => ({ domains: [...supported], services: ['theme', ...(supported.has('identity') ? ['identity'] : [])] }),
    },
  };
}

const privilegedRequests = new Set(['identity.getPublicKey', 'identity.getRelays', 'identity.getProfile',
  'identity.getFollows', 'identity.getMutes', 'identity.getBlocked', 'identity.getList',
  'identity.getZaps', 'identity.getBadges', 'storage.get', 'storage.set', 'storage.remove', 'storage.keys', 'relay.query', 'outbox.query', 'outbox.getEvent', 'outbox.resolveRelays', 'outbox.publish', 'resource.info', 'resource.bytes', 'resource.bytesMany', 'resource.cancel']);
function validEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if (typeof message.type === 'string' && message.type.startsWith('config.')) {try {parseConfigMessage(value); return true;} catch {return false;}}
  if (typeof message.type === 'string' && message.type.startsWith('notify.')) {try {parseNotifyMessage(value); return true;} catch {return false;}}
  if (typeof message.type === 'string' && (message.type.startsWith('intent.') || message.type.startsWith('inc.'))) { try { parseRoutingMessage(value); return true; } catch { return false; } }
  if (message.type === 'link.open') return linkRequestId(value) !== null;
  if (typeof message.type === 'string' && message.type.startsWith('upload.')) {
    try { parseUploadRequest(value); return true; } catch { return false; }
  }
  if(message.type==='outbox.subscribe'||message.type==='outbox.close'){try{if(message.type==='outbox.subscribe')parseOutboxSubscribe(value);else parseOutboxClose(value);return true;}catch{return false;}}
  if(message.type==='relay.subscribe'||message.type==='relay.close') {
    try {if(message.type==='relay.subscribe')parseRelaySubscribe(value);else parseRelayClose(value);return true;}catch{return false;}
  }
  if (message.type === 'shell.ready') return keys.length === 1;
  if (typeof message.type === 'string' && privilegedRequests.has(message.type)) {
    try { return typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
      && new TextEncoder().encode(JSON.stringify(value)).length <= 2 * 1024 * 1024; }
    catch { return false; }
  }
  if (message.type === 'relay.publish') {
    if (keys.length !== 3 || !keys.includes('id') || !keys.includes('event') ||
        typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 128) return false;
    const event = message.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const eventKeys = Object.keys(event);
    if (eventKeys.length !== 4 || !['kind', 'content', 'tags', 'created_at'].every(key => eventKeys.includes(key))) return false;
    const template = event as Record<string, unknown>;
    if (typeof template.kind !== 'number' || !Number.isSafeInteger(template.kind) || template.kind < 0 || template.kind > 65535 ||
        typeof template.created_at !== 'number' || !Number.isSafeInteger(template.created_at) || template.created_at < 0 ||
        typeof template.content !== 'string' || !Array.isArray(template.tags)) return false;
    try { return new TextEncoder().encode(JSON.stringify(value)).length <= 2 * 1024 * 1024; }
    catch { return false; }
  }
  return message.type === 'theme.get' && keys.length === 2
    && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
    && keys.every(key => key === 'type' || key === 'id');
}

function createGuestFrame(title: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.id = 'napplet';
  frame.title = title;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'");
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0;height:100%;overflow:hidden;background:#140f0b;color:#f3efeb}iframe{display:block;width:100%;height:100%;border:0}body>p{font:16px system-ui;padding:24px}';
  document.head.append(style);
  document.body.replaceChildren(frame);
  return frame;
}

function approvalTimeouts(artifact: RuntimeArtifact): Readonly<Record<string, number>> {
  return Object.freeze({
    ...(artifact.domains.includes('relay')
      ? { 'relay.publish': artifact.publishTimeoutMs ?? 660_000 } : {}),
    ...(artifact.domains.includes('outbox') ? { 'outbox.publish': 660_000 } : {}),
  });
}

function rejectEnvelope(event: MessageEvent, source: Window, domains: readonly string[]): void {
      if (domains.includes('notify')) {
        const rejection = captureNotifyRejection(event.data);
        if (rejection !== null) source.postMessage({...rejection}, '*');
      }
      // A denied subscribe acquires no Kehto/native authority. Reply only to the captured
      // registered frame with an independently validated caller correlation identifier.
      if (domains.includes('relay') && (event.data?.type === 'relay.subscribe' || domains.includes('outbox') && event.data?.type === 'outbox.subscribe')) {
        try {
          const outbox=event.data.type==='outbox.subscribe';
          const denied = outbox?parseOutboxClose({type:'outbox.close',id:event.data.id,subId:event.data.subId}):parseRelayClose({type:'relay.close',id:event.data.id,subId:event.data.subId});
          source.postMessage({type:outbox?'outbox.closed':'relay.closed',subId:denied.subId,reason:'invalid or unsupported relay subscription'}, '*');
        } catch { /* An invalid correlation identifier has no SDK recipient. */ }
      }
}

function mount(artifact: RuntimeArtifact): void {
  let routingContext: ServiceRuntimeContext | null = null;
  const native = createNativeClient(hostWindow.HypergolicHost!, sessionId,
    { requestTimeoutsMs: approvalTimeouts(artifact),
      onRouting: message => {
        if (stopped || !ready || frame.contentWindow !== source || !bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId)) return;
        const domain = message.type.split('.')[0]!;
        if (artifact.domains.includes(domain)) routingContext?.sendToEligibleNapplet(sessionId, message);
      } });
  const shellTheme = createShellTheme(theme => bridge.publishTheme(theme));
  const hooks = makeHooks(native, () => {
    const entry = bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId);
    return () => !stopped && entry !== undefined && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId) === entry;
  }, artifact, shellTheme.theme, context => { routingContext = context; });
  const bridge = createShellBridge(hooks);
  const identity = Object.freeze({ dTag: artifact.appId, aggregateHash: artifact.aggregateHash });
  const resolved = resolveShellEnvironment(hooks, identity);
  const environment = {...resolved, services: [...resolved.services, CLOSE_CHECK_SERVICE]};
  const frame = createGuestFrame(artifact.title);
  const source = frame.contentWindow;
  if (!source) { bridge.destroy(); throw new Error('Frame unavailable'); }
  const media = bindResourceMedia(source);
  const policy = artifact.domains.includes('resource') ? csp.replace("media-src 'none'", 'media-src blob:') : csp;
  originRegistry.register(source, sessionId, identity);
  originRegistry.setEnvironment(source, environment);
  let ready = false;
  let frameLoaded = false;
  let operations = 0;
  let windowStart = performance.now();
  const closeCheck = installCloseCheck(source, () => !stopped && ready && frame.contentWindow === source &&
    bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId) !== undefined,
    (id, state) => hostWindow.HypergolicHost?.postMessage(JSON.stringify({type: 'close-check.result', sessionId, id, state})));
  const deadline = window.setTimeout(() => fail('runtime-timeout'), 10_000);

  const receive = (event: MessageEvent): void => {
    if (stopped || !event.isTrusted || event.source !== source || frame.contentWindow !== source) return;
    if (performance.now() - windowStart > 1000) { operations = 0; windowStart = performance.now(); }
    if (++operations > 64) return;
    if (!validEnvelope(event.data)) {
      if (ready && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId)) rejectEnvelope(event, source, artifact.domains);
      return;
    }
    // Kehto performs session gating, frozen capability enforcement and theme dispatch.
    bridge.handleMessage(event);
    if (!ready && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId)) {
      ready = true;
      window.clearTimeout(deadline);
      diagnostic({ type: 'ready', sessionId });
      if (artifact.domains.includes('notify')) void native.notify({type: 'notify.__register'}).catch(() => {});
      if (artifact.domains.includes('intent') || artifact.domains.includes('inc')) void native.routing({type: 'routing.__register'}).catch(() => {});
    }
  };
  const loaded = (): void => {
    // Registered WindowProxy references can survive self-navigation. End the
    // generation on any subsequent document load; never bless new source bytes.
    if (frameLoaded) { fail('frame-navigation'); return; }
    frameLoaded = true;
    media.refresh();
    if (frame.contentWindow !== source) fail('frame-navigation');
  };
  cleanup = (): void => {
    shellTheme.close();
    closeCheck();
    media.close();
    window.clearTimeout(deadline);
    window.removeEventListener('message', receive);
    frame.removeEventListener('load', loaded);
    bridge.runtime.destroyWindow(sessionId);
    originRegistry.unregister(sessionId);
    native.destroy();
    bridge.destroy();
    frame.remove();
  };
  window.addEventListener('message', receive);
  frame.addEventListener('load', loaded);
  frame.srcdoc = injectNappletNamespacePrelude(injectSupportReport(injectResourceMediaGate(artifact.published
    ? injectPublishedCsp(artifact.html, policy) : injectCsp(artifact.html, policy))), {
    ...environment.capabilities,
    requestTimeoutsMs: approvalTimeouts(artifact),
  });
}

async function start(): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) { fail('invalid-session'); return; }
  if (window.parent !== window || typeof hostWindow.HypergolicHost?.postMessage !== 'function') {
    fail('bridge-unavailable'); return;
  }
  try {
    ensureObjectHasOwn();
    ensureSecureRandomUuid();
    let artifact: RuntimeArtifact;
    if (source === 'published') {
      if (Array.from(parameters).length !== 2 || parameters.get('fixture') !== null) { fail('artifact-integrity'); return; }
      const document = await readPublishedArtifact(hostWindow.HypergolicHost!, sessionId);
      artifact = Object.freeze({ html: document.html, sha256: document.metadata.htmlHash,
        aggregateHash: document.metadata.version, appId: document.metadata.appId,
        title: document.metadata.appId, domains: document.metadata.domains, published: true });
    } else {
      if (source !== null || !fixture) { fail('fixture-integrity'); return; }
      const actual = await digest(fixture.html);
      if (actual !== fixture.sha256 || await digest(`${actual} /index.html\n`) !== fixture.aggregateHash) {
        fail('fixture-integrity'); return;
      }
      artifact = Object.freeze({ ...fixture, published: false });
    }
    if (stopped) return;
    mount(artifact);
  } catch { fail(source === 'published' ? 'artifact-integrity' : 'runtime-bootstrap'); }
}
void start();
