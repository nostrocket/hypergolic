import {createCvmGuestReceiver} from './cvm-native';
import {injectCvmFacade} from './cvm-guest';
import './legacy-webview';
import {COMMON_OPERATIONS,parseCommonRequest,commonFailure} from '../../src/common/common-contract';
import { injectMediaFacade } from './media-guest';
import { guestMessageReceiver } from './guest-message-receiver';
import { injectAndroidGuestHelpers } from './android-guest-helpers';
import { createDiscoveryOpenReceiver, injectDiscoveryOpen } from './discovery-open';
import { createCatalogPageReceiver } from './discovery-catalog';
import { installCloseCheck, CLOSE_CHECK_SERVICE } from './close-check';
import { injectSupportReport } from './support-report';
import {parseOutboxSubscribe,parseOutboxClose} from '../../src/outbox/subscription-contract';
import {createConfigAdapter} from './config-adapter';
import {parseConfigMessage} from '../../src/presentation/config-contract';
import {createNotifyAdapter} from './notify-adapter';
import {captureNotifyRejection, parseNotifyMessage} from '../../src/presentation/notify-contract';
import { createRoutingAdapter } from './routing-adapter';
import { createGuestRouting } from './intent-delivery';
import { parseRoutingMessage } from '../../src/routing/routing-contract';
import { createLinkAdapter } from './link-adapter';
import { linkRequestId } from '../../src/links/link-contract';
import { createUploadAdapter } from './upload-adapter';
import { parseUploadRequest, UploadError, UPLOAD_LIMITS } from '../../src/uploads/upload-contract';
import { text } from '../../src/storage/codec';
import { bindResourceMedia, injectResourceMediaGate, isRuntimeInputActive } from './resource-media';
import { createKeysSession } from './keys-adapter';
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
import { publishedCspParts, readPublishedArtifact } from './published-artifact';
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
type RuntimeMetadata = Readonly<{
  aggregateHash: string; appId: string; title: string;
  domains: readonly string[]; publishTimeoutMs?: number; published: boolean; discoveryOpen: boolean;
}>;
let stopped = false;
let cleanup: (() => void) | undefined;
function stop(): boolean {
  if (stopped) return false;
  stopped = true;
  const dispose = cleanup;
  cleanup = undefined;
  dispose?.();
  return true;
}
window.addEventListener('pagehide', stop, { once: true });

function diagnostic(value: HostDiagnostic): void {
  const encoded = JSON.stringify(value);
  if (encoded.length > 2048) return;
  try { hostWindow.HypergolicHost?.postMessage(encoded); } catch { /* native teardown */ }
}
function fail(code: FailureCode): void {
  if (!stop()) return;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'The napplet could not be loaded.';
  document.body.replaceChildren(message);
  diagnostic({ type: 'error', sessionId, code });
}

const csp = [
  "default-src 'none'", "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  "connect-src 'none'", "worker-src blob:", "child-src 'none'", "frame-src 'none'",
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
  artifact: RuntimeMetadata, theme: ThemeService, registerRouting: (context: ServiceRuntimeContext | null) => void): ShellAdapter {
  const unavailable = (): never => { throw new Error('Capability unavailable'); };
  const supported = new Set(artifact.domains);
  const routing = createRoutingAdapter(native, captureRecipient);
  const notify = createNotifyAdapter(native, captureRecipient);
  const config = createConfigAdapter(native, captureRecipient);
  const resource = createResourceAdapter(native, captureRecipient);
  const upload = createUploadAdapter(native, captureRecipient);
  const capability = async ({ message, send }: HostOperationContext): Promise<void> => { send({ ...await native.request(message) }); };
  const relayPublish = async ({ message, send }: HostOperationContext): Promise<void> => { send({ ...await native.request(message) }); };
  const relaySubscribe = ({message,send}:HostOperationContext):void => {
    const live=captureRecipient();
    try { native.subscribe(message,response=>{if(live())send({...response});}); }
    catch { if(live()){const outbox=message.type==='outbox.subscribe';const request=outbox?parseOutboxClose({type:'outbox.close',id:message.id,subId:message.subId}):parseRelayClose({type:'relay.close',id:message.id,subId:message.subId});send({type:outbox?'outbox.closed':'relay.closed',subId:request.subId,reason:'relay subscription unavailable'});} }
  };
  const relayClose = ({message}:HostOperationContext):void => { native.close(message); };
  const common = {descriptor: {name: 'common', version: '1.0.0'},
    handleMessage(_windowId: string, message: NappletMessage, send: (message: NappletMessage) => void): void {
      const live = captureRecipient();
      void native.request(message).then(response => {if (live()) send(response);}).catch(() => {
        const failure = commonFailure(message, 'relay-timeout');
        if (live() && failure) send(failure as NappletMessage);
      });
    },
  };
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
    common: {isAvailable: () => supported.has('common')},
    services: { theme: theme.handler,
      ...(supported.has('config') ? {config: {descriptor: {name: 'config', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('notify') ? {notify: {descriptor: {name: 'notify', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('intent') ? {intent: {descriptor: {name: 'intent', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('inc') ? {inc: {descriptor: {name: 'inc', version: '1.0.0'}, handleMessage: unavailable, onRegistered: registerRouting, onUnregistered: () => registerRouting(null)}} : {}),
      ...(supported.has('link') ? {link: createLinkAdapter(native, captureRecipient)} : {}),
      ...(supported.has('upload') ? { upload: { descriptor: { name: 'upload', version: '1.0.0' }, handleMessage: unavailable } } : {}), ...(supported.has('identity') ? { identity } : {}),
      ...(supported.has('resource') ? { resource: { descriptor: { name: 'resource', version: '1.0.0' }, handleMessage: unavailable } } : {}),
      ...(supported.has('common') ? {common} : {}),
      ...(supported.has('cvm')?{cvm:{descriptor:{name:'cvm',version:'1.0.0'},handleMessage:unavailable}}:{}),
      ...(supported.has('outbox') ? {outbox: {descriptor: {name: 'outbox', version: '1.0.0'}, handleMessage: unavailable}} : {}),
      ...(supported.has('relay') ? { relay: { descriptor: { name: 'relay', version: '1.0.0' }, handleMessage: unavailable } } : {}) },
    ...((supported.has('storage') || supported.has('relay') || supported.has('resource') || supported.has('upload') || supported.has('intent') || supported.has('inc') || supported.has('notify') || supported.has('config') || supported.has('outbox') || supported.has('common')) ? { operationOverrides: {
      ...(supported.has('config') ? {'config.registerSchema': config, 'config.get': config, 'config.subscribe': config, 'config.unsubscribe': config, 'config.openSettings': config} : {}),
      ...(supported.has('notify') ? {'notify.send': notify, 'notify.dismiss': notify, 'notify.badge': notify, 'notify.channel.register': notify, 'notify.permission.request': notify} : {}),
      ...(supported.has('intent') ? { 'intent.invoke': routing, 'intent.available': routing, 'intent.handlers': routing } : {}),
      ...(supported.has('inc') ? { 'inc.subscribe': routing, 'inc.unsubscribe': routing, 'inc.emit': routing, 'inc.channel.open': routing, 'inc.channel.list': routing, 'inc.channel.emit': routing, 'inc.channel.broadcast': routing, 'inc.channel.close': routing } : {}),
      ...(supported.has('upload') ? { 'upload.info': upload, 'upload.upload': upload, 'upload.status': upload } : {}),
      ...(supported.has('resource') ? { 'resource.info': resource, 'resource.bytes': resource, 'resource.bytesMany': resource, 'resource.cancel': resource } : {}),
      ...(supported.has('storage') ? { 'storage.get': capability, 'storage.set': capability, 'storage.remove': capability, 'storage.keys': capability } : {}),
      ...(supported.has('outbox') ? {'outbox.query': relayPublish, 'outbox.getEvent': relayPublish, 'outbox.resolveRelays': relayPublish, 'outbox.publish': relayPublish, 'outbox.subscribe': relaySubscribe, 'outbox.close': relayClose} : {}),
      ...(supported.has('relay') ? { 'relay.publish': relayPublish, 'relay.query': relayPublish, 'relay.subscribe': relaySubscribe, 'relay.close': relayClose } : {}),
    } } : {}),
    capabilities: {
      disabledDomains: ['link', 'upload', 'resource', 'relay', 'identity', 'storage', 'intent', 'inc', 'keys', 'media', 'notify', 'config', 'outbox', 'common', 'cvm'].filter(domain => !supported.has(domain)),
      resolveEnvironment: () => ({ domains: [...supported], services: ['theme', ...(supported.has('identity') ? ['identity'] : [])] }),
    },
  };
}

const privilegedRequests = new Set([...COMMON_OPERATIONS,'identity.getPublicKey', 'identity.getRelays', 'identity.getProfile',
  'identity.getFollows', 'identity.getMutes', 'identity.getBlocked', 'identity.getList',
  'identity.getZaps', 'identity.getBadges', 'storage.get', 'storage.set', 'storage.remove', 'storage.keys', 'relay.query', 'outbox.query', 'outbox.getEvent', 'outbox.resolveRelays', 'outbox.publish', 'resource.info', 'resource.bytes', 'resource.bytesMany', 'resource.cancel']);
function validEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if (typeof message.type === 'string' && message.type.startsWith('common.')) {try {parseCommonRequest(value); return true;} catch {return false;}}
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

function approvalTimeouts(artifact: RuntimeMetadata): Readonly<Record<string, number>> {
  return Object.freeze({
    ...(artifact.domains.includes('relay')
      ? { 'relay.publish': artifact.publishTimeoutMs ?? 660_000 } : {}),
    ...(artifact.domains.includes('outbox') ? { 'outbox.publish': 660_000 } : {}),
    ...(artifact.domains.includes('common') ? {'common.follow':660_000,'common.unfollow':660_000,'common.react':660_000,'common.report':660_000}:{}),
  });
}

function rejectEnvelope(event: MessageEvent, source: Window, domains: readonly string[]): void {
      if (domains.includes('common')) {
        const reply = commonFailure(event.data);
        if (reply) {source.postMessage(reply,'*');return;}
      }
      if (domains.includes('relay') && event.data?.type === 'relay.publish') {
        const id = event.data.id;
        if (typeof id === 'string' && id.length > 0 && id.length <= 128 &&
          new TextEncoder().encode(id).length <= 128) {
          source.postMessage({type: 'relay.publish.result', id, ok: false, error: 'Invalid event template.'}, '*');
        }
        return;
      }
      const type = event.data?.type;
      if (domains.includes('upload') && (type === 'upload.info' || type === 'upload.upload' || type === 'upload.status')) {
        let id: string;
        try { id = text(event.data.id, UPLOAD_LIMITS.idBytes); } catch { return; }
        try { parseUploadRequest(event.data); } catch (error) {
          source.postMessage({type: type + '.result', id, error: error instanceof UploadError ? error.code : 'invalid request'}, '*');
        }
        return;
      }
      if (domains.includes('notify')) {
        const rejection = captureNotifyRejection(event.data);
        if (rejection !== null) source.postMessage({...rejection}, '*');
      }
      // A denied subscribe acquires no Kehto/native authority. Reply only to the captured
      // registered frame with an independently validated caller correlation identifier.
      if ((event.data?.type === 'relay.subscribe' && domains.includes('relay')) ||
          (event.data?.type === 'outbox.subscribe' && domains.includes('outbox'))) {
        try {
          const outbox=event.data.type==='outbox.subscribe';
          const denied = outbox?parseOutboxClose({type:'outbox.close',id:event.data.id,subId:event.data.subId}):parseRelayClose({type:'relay.close',id:event.data.id,subId:event.data.subId});
          source.postMessage({type:outbox?'outbox.closed':'relay.closed',subId:denied.subId,reason:'invalid or unsupported relay subscription'}, '*');
        } catch { /* An invalid correlation identifier has no SDK recipient. */ }
      }
}

function createGuestEndpoint(artifact: RuntimeMetadata, hooks: ShellAdapter) {
  const bridge = createShellBridge(hooks);
  const identity = Object.freeze({ dTag: artifact.appId, aggregateHash: artifact.aggregateHash });
  const resolved = resolveShellEnvironment(hooks, identity);
  const environment = {...resolved, services: [...resolved.services, CLOSE_CHECK_SERVICE]};
  const frame = createGuestFrame(artifact.title);
  const source = frame.contentWindow;
  if (!source) { bridge.destroy(); throw new Error('Frame unavailable'); }
  const media = bindResourceMedia(source, frame);
  const policy = artifact.domains.includes('resource') ? csp.replace("media-src 'none'", 'media-src blob:') : csp;
  originRegistry.register(source, sessionId, identity);
  originRegistry.setEnvironment(source, environment);
  return { bridge, frame, source, media, environment, policy };
}

function mount(artifact: RuntimeMetadata) {
  const live = () => !stopped && ready && frame.contentWindow === source && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId) !== undefined;
  const routing = createGuestRouting(artifact.domains, sessionId, live,
    () => { void native.routing({type: 'routing.__register'}).catch(() => {}); }, () => fail('runtime-bootstrap'));
  const native = createNativeClient(hostWindow.HypergolicHost!, sessionId,
    {requestTimeoutsMs: approvalTimeouts(artifact), onRouting: routing.deliver, onMedia: message => {
      if (hasMedia && live()) source.postMessage(message, '*');
    },onCvm:message=>{if(artifact.domains.includes('cvm')&&live())source.postMessage(message,'*');}});
  const shellTheme = createShellTheme(theme => bridge.publishTheme(theme));
  const hooks = makeHooks(native, () => {
    const entry = bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId);
    return () => !stopped && entry !== undefined && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId) === entry;
  }, artifact, shellTheme.theme, routing.setContext);
  const { bridge, frame, source, media, environment, policy } = createGuestEndpoint(artifact, hooks);
  const hasMedia = artifact.published && artifact.domains.includes('media');
  let ready = false;
  const keys = artifact.domains.includes('keys') ? createKeysSession(source, () =>
    live() && isRuntimeInputActive() && document.hasFocus() && document.activeElement === frame) : null;
  let frameLoaded = false;
  const closeCheck = installCloseCheck(source, live,
    (id, state) => hostWindow.HypergolicHost?.postMessage(JSON.stringify({type: 'close-check.result', sessionId, id, state})));
  const discoveryToken = artifact.discoveryOpen ? crypto.randomUUID() : null;
  const discoveryOpen = discoveryToken ? createDiscoveryOpenReceiver(source, native, discoveryToken, live) : null;
  const catalogPage = discoveryToken && artifact.domains.includes('relay')
    ? createCatalogPageReceiver(source, native, discoveryToken, live) : null;
  const deadline = window.setTimeout(() => fail('runtime-timeout'), 10_000);

  const receive = guestMessageReceiver(frame, source, {
    routing, discoveryOpen, catalogPage, keys, sendMedia: hasMedia ? native.sendMedia : null,
    cvm:artifact.domains.includes('cvm')?createCvmGuestReceiver(source,native.cvm,live):null,
    closed: () => stopped, live,
    dispatch(event) {
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
        keys?.refresh();
        if (artifact.domains.includes('notify')) void native.notify({type: 'notify.__register'}).catch(() => {});
        routing.ready();
      }
    },
  });
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
    routing.close();
    keys?.close();
    media.close();
    window.clearTimeout(deadline);
    window.removeEventListener('message', receive);
    frame.removeEventListener('load', loaded);
    bridge.runtime.destroyWindow(sessionId);
    originRegistry.unregister(sessionId);
    native.destroy();
    bridge.destroy();
    frame.remove();
    frame.removeAttribute('srcdoc');
  };
  window.addEventListener('message', receive);
  frame.addEventListener('load', loaded);
  return {frame, environment, policy, discoveryToken};
}

// Mount listeners receive metadata only, so they cannot retain the original HTML.
function renderGuest(artifact: RuntimeMetadata, rawHtml: string): void {
  const {frame, environment, policy, discoveryToken} = mount(artifact);
  const [prefix, withCsp] = artifact.published
    ? publishedCspParts(rawHtml, policy) : ['', injectCsp(rawHtml, policy)] as const;
  const html = discoveryToken ? injectDiscoveryOpen(withCsp, discoveryToken, artifact.domains.includes('relay')) : withCsp;
  const guest = injectAndroidGuestHelpers(injectResourceMediaGate(html));
  const injected = injectNappletNamespacePrelude(injectSupportReport(guest), {
    ...environment.capabilities,
    requestTimeoutsMs: approvalTimeouts(artifact),
  });
  const withMedia=artifact.published && artifact.domains.includes('media') ? injectMediaFacade(injected) : injected;
  frame.srcdoc = prefix + (artifact.published && artifact.domains.includes('cvm') ? injectCvmFacade(withMedia) : withMedia);
}

async function start(): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) { fail('invalid-session'); return; }
  if (window.parent !== window || typeof hostWindow.HypergolicHost?.postMessage !== 'function') {
    fail('bridge-unavailable'); return;
  }
  try {
    ensureSecureRandomUuid();
    if (source === 'published') {
      if (Array.from(parameters).length !== 2 || parameters.get('fixture') !== null) { fail('artifact-integrity'); return; }
      const {html, metadata} = await readPublishedArtifact(hostWindow.HypergolicHost!, sessionId);
      const {appId, version: aggregateHash, domains, publishedOpen} = metadata;
      if (!stopped) renderGuest({aggregateHash, appId, title: appId, domains,
        published: true, discoveryOpen: publishedOpen === true}, html);
      return;
    }
    if (source !== null || !fixture) { fail('fixture-integrity'); return; }
    const {html, sha256, ...metadata} = fixture;
    const actual = await digest(html);
    if (actual !== sha256 || await digest(`${actual} /index.html\n`) !== metadata.aggregateHash) {
      fail('fixture-integrity'); return;
    }
    if (!stopped) renderGuest({...metadata, published: false,
      discoveryOpen: fixtureName === 'napplet-discovery' && metadata.appId === 'napplet-discovery'}, html);
  } catch { fail(source === 'published' ? 'artifact-integrity' : 'runtime-bootstrap'); }
}
void start();
