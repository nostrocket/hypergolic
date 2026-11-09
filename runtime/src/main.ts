import {createLegacyImageMount} from './legacy-image-mount';
import {injectLegacyImages} from './legacy-image-guest';
import {injectReviewedPresentation} from './reviewed-presentation';
import {injectCreatorUpload} from './reviewed-creator-upload';
import {supportsMappletsTouchSelection} from './reviewed-mapplets-touch';
import {validEnvelope, rejectEnvelope} from './guest-envelope';
import {commonFailure} from '../../src/common/common-contract';
import {parseOutboxClose} from '../../src/outbox/subscription-contract';
import {parseRelayClose} from '../../src/network/relay-subscription-contract';
import {createLegacyDocumentGuard} from './legacy-lifecycle';
import type {LegacyReadOnlyContext} from '../../src/napplets/legacy-read-only.ts';
import {createLegacyMount} from './legacy-mount';
import {injectLegacyReadOnly, injectLegacyLongformLayout} from './legacy-guest';
import {injectLegacyRecipeModules} from './legacy-modules';
import {createMeshGuestReceiver, isNativeMeshContext, type NativeMeshContext} from './mesh-native.ts';
import {injectMeshFacade} from './mesh-guest.ts';
import type {AppDataPolicy} from '../../src/app-data/app-data-context';
import {createCvmGuestReceiver} from './cvm-native';
import {injectCvmFacade} from './cvm-guest';
import './legacy-webview';
import { injectMediaFacade } from './media-guest';
import { guestMessageReceiver } from './guest-message-receiver';
import { injectAndroidGuestHelpers } from './android-guest-helpers';
import { createDiscoveryOpenReceiver, injectDiscoveryOpen } from './discovery-open';
import { createCatalogPageReceiver } from './discovery-catalog';
import { installCloseCheck, CLOSE_CHECK_SERVICE } from './close-check';
import { injectSupportReport } from './support-report';
import {createConfigAdapter} from './config-adapter';
import {createNotifyAdapter} from './notify-adapter';
import { createRoutingAdapter } from './routing-adapter';
import { createGuestRouting } from './intent-delivery';
import { createLinkAdapter } from './link-adapter';
import { createUploadAdapter } from './upload-adapter';
import { bindResourceMedia, injectResourceMediaGate, isRuntimeInputActive } from './resource-media';
import { createKeysSession } from './keys-adapter';
import { createResourceAdapter } from './resource-adapter';
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
  domains: readonly string[]; appData?:AppDataPolicy; mesh?:NativeMeshContext; legacyReadOnly?:LegacyReadOnlyContext; publishTimeoutMs?: number; published: boolean; discoveryOpen: boolean;
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
  const supported = new Set(artifact.domains.filter(domain => domain !== 'mesh' || artifact.published && isNativeMeshContext(artifact.mesh, sessionId)));
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
      ...(artifact.appData?{appData:artifact.appData}:{}),
      disabledDomains: ['link', 'upload', 'resource', 'relay', 'identity', 'storage', 'intent', 'inc', 'keys', 'media', 'notify', 'config', 'outbox', 'common', 'cvm', 'mesh'].filter(domain => !supported.has(domain)),
      resolveEnvironment: () => ({ domains: [...supported], services: ['theme', ...(supported.has('identity') ? ['identity'] : [])] }),
    },
  };
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

function createGuestEndpoint(artifact: RuntimeMetadata, hooks: ShellAdapter) {
  const bridge = createShellBridge(hooks);
  const identity = Object.freeze({ dTag: artifact.appId, aggregateHash: artifact.aggregateHash });
  const resolved = resolveShellEnvironment(hooks, identity);
  // Mesh uses the private native lane, outside the SDK's fixed domain catalogue.
  const nativeMesh = artifact.published && artifact.domains.includes('mesh') && isNativeMeshContext(artifact.mesh, sessionId);
  const environment = {...resolved, capabilities: {...resolved.capabilities,
    domains: Object.freeze([...resolved.capabilities.domains, ...(nativeMesh ? ['mesh'] : [])])},
    services: [...resolved.services, CLOSE_CHECK_SERVICE]};
  const frame = createGuestFrame(artifact.title);
  const source = frame.contentWindow;
  if (!source) { bridge.destroy(); throw new Error('Frame unavailable'); }
  const media = bindResourceMedia(source, frame);
  const policy = artifact.legacyReadOnly ? csp.replace("script-src 'unsafe-inline' 'wasm-unsafe-eval'", "script-src 'unsafe-inline' blob:").replace('worker-src blob:', "worker-src 'none'")
    : artifact.domains.includes('resource') ? csp.replace("media-src 'none'", 'media-src blob:') : csp;
  originRegistry.register(source, sessionId, identity);
  originRegistry.setEnvironment(source, environment);
  return { bridge, frame, source, media, environment, policy };
}

function createLoadHandler(frame: HTMLIFrameElement, source: Window,
  media: ReturnType<typeof bindResourceMedia>, legacyGuard: ReturnType<typeof createLegacyDocumentGuard> | undefined,
  failed: () => void): () => void {
  let frameLoaded = false;
  return (): void => {
    // A same-document legacy load must prove ownership of the original private port.
    if (legacyGuard) {legacyGuard.loaded(); media.refresh(); return;}
    if (frameLoaded) {failed(); return;}
    frameLoaded = true;
    media.refresh();
    if (frame.contentWindow !== source) failed();
  };
}

function mount(artifact: RuntimeMetadata) {
  let legacyGuard: ReturnType<typeof createLegacyDocumentGuard> | undefined;
  const live = () => !stopped && frame.contentWindow === source && (artifact.legacyReadOnly !== undefined ? legacyGuard?.isActive() === true : ready && bridge.runtime.sessionRegistry.getEntryByWindowId(sessionId) !== undefined);
  const routing = createGuestRouting(artifact.domains, sessionId, live,
    () => { void native.routing({type: 'routing.__register'}).catch(() => {}); }, () => fail('runtime-bootstrap'));
  const native = createNativeClient(hostWindow.HypergolicHost!, sessionId,
    {requestTimeoutsMs: approvalTimeouts(artifact), ...(artifact.published && artifact.mesh ? {mesh: artifact.mesh} : {}), onRouting: routing.deliver, onMedia: message => {
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
  const legacyMount = createLegacyMount(artifact.legacyReadOnly, artifact.appId, frame, source, native, live,
    () => fail('frame-navigation'), () => {
      if (!ready) {ready = true; window.clearTimeout(deadline); diagnostic({type: 'ready', sessionId});}
    });
  legacyGuard = legacyMount?.guard;
  const legacyNonce = legacyMount?.nonce ?? null;
  const legacyImages = legacyMount ? createLegacyImageMount(frame, source, legacyMount.nonce, native, legacyMount.guard,
    () => !stopped && frame.contentWindow === source) : null;
  const legacy = legacyMount?.receiver;
  const mesh = artifact.published && isNativeMeshContext(artifact.mesh, sessionId) && artifact.domains.includes('mesh')
    ? createMeshGuestReceiver(frame, source, native.mesh, live) : null;
  const keys = artifact.domains.includes('keys') ? createKeysSession(source, () =>
    live() && isRuntimeInputActive() && document.hasFocus() && document.activeElement === frame) : null;
  const closeCheck = installCloseCheck(source, live,
    (id, state) => hostWindow.HypergolicHost?.postMessage(JSON.stringify({type: 'close-check.result', sessionId, id, state})));
  const discoveryToken = artifact.discoveryOpen ? crypto.randomUUID() : null;
  const discoveryOpen = discoveryToken ? createDiscoveryOpenReceiver(source, native, discoveryToken, live) : null;
  const catalogPage = discoveryToken && artifact.domains.includes('relay')
    ? createCatalogPageReceiver(source, native, discoveryToken, live) : null;
  const deadline = window.setTimeout(() => fail('runtime-timeout'), 10_000);

  const receiveGuest = guestMessageReceiver(frame, source, {
    routing, discoveryOpen, catalogPage, keys, sendMedia: hasMedia ? native.sendMedia : null,
    cvm:artifact.domains.includes('cvm')?createCvmGuestReceiver(source,native.cvm,live):null,
    closed: () => stopped, live,
    dispatch(event) {
      if (legacyImages?.receive(event)) return;
      if (legacy?.receive(event)) return;
      if (artifact.legacyReadOnly) return;
      if (mesh?.receive(event)) return;
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
  const loaded = createLoadHandler(frame, source, media, legacyGuard, () => fail('frame-navigation'));
  cleanup = (): void => {
    shellTheme.close();
    closeCheck();
    routing.close();
    mesh?.close();
    legacyImages?.close();
    legacyMount?.close();
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
  const receive = (event: MessageEvent): void => {if (legacyGuard) legacyGuard.receive(event, receiveGuest); else receiveGuest(event);};
  window.addEventListener('message', receive);
  frame.addEventListener('load', loaded);
  return {frame, environment, policy, discoveryToken, legacyNonce};
}

// Mount listeners receive metadata only, so they cannot retain the original HTML.
function renderGuest(artifact: RuntimeMetadata, rawHtml: string): void {
  const {frame, environment, policy, discoveryToken, legacyNonce} = mount(artifact);
  const [prefix, withCsp] = artifact.published
    ? publishedCspParts(rawHtml, policy) : ['', injectCsp(rawHtml, policy)] as const;
  if (legacyNonce) {
    const modules = artifact.appId === 'recipe-cards' ? injectLegacyRecipeModules(withCsp) : withCsp;
    const layout = artifact.appId === 'longform' ? injectLegacyLongformLayout(modules) : modules;
    frame.srcdoc = prefix + injectLegacyReadOnly(injectLegacyImages(injectAndroidGuestHelpers(injectResourceMediaGate(layout)), legacyNonce), legacyNonce);
    return;
  }
  const presentation = injectReviewedPresentation(withCsp, artifact);
  const html = discoveryToken ? injectDiscoveryOpen(presentation, discoveryToken, artifact.domains.includes('relay')) : presentation;
  const guest = injectAndroidGuestHelpers(injectResourceMediaGate(html, supportsMappletsTouchSelection(artifact)));
  const injected = injectNappletNamespacePrelude(injectCreatorUpload(injectSupportReport(guest), artifact), {
    ...environment.capabilities,
    requestTimeoutsMs: approvalTimeouts(artifact),
  });
  const withMedia=artifact.published && artifact.domains.includes('media') ? injectMediaFacade(injected) : injected;
  const withCvm = artifact.published && artifact.domains.includes('cvm') ? injectCvmFacade(withMedia) : withMedia;
  frame.srcdoc = prefix + (artifact.published && isNativeMeshContext(artifact.mesh, sessionId) && artifact.domains.includes('mesh') ? injectMeshFacade(withCvm) : withCvm);
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
      const {appId, version: aggregateHash, domains, publishedOpen, appData, mesh, legacyReadOnly, snapshot} = metadata;
      if (!stopped) renderGuest({aggregateHash, appId, title: snapshot?.title ?? appId, domains,...(appData?{appData:appData.policy}:{}), ...(mesh ? {mesh} : {}), ...(legacyReadOnly ? {legacyReadOnly} : {}),
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
