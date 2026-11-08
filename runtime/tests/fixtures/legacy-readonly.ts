import {createLegacyDocumentGuard} from '../../src/legacy-lifecycle';
import {injectLegacyReadOnly} from '../../src/legacy-guest';
import {injectLegacyRecipeModules} from '../../src/legacy-modules';
import {createLegacyReadOnlyReceiver} from '../../src/legacy-readonly';
import {createNativeClient} from '../../src/native-client';
import {verifyQueryEvent} from '../../../src/network/relay-query-contract';
const session = '12345678-1234-4234-8234-123456789abc';
const policy = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const state: any = {requests: [], closes: [], status: [], deliveries: [], session, auto: null, live: true};
function mount(html: string, recipe = false, guarded = false): void {
  state.destroy?.(); state.receiver?.destroy(); document.body.replaceChildren();
  state.requests = []; state.closes = []; state.status = []; state.deliveries = []; state.live = true; state.revoked = 0; state.resumed = 0; state.queueRuns = 0;
  const frame = document.createElement('iframe'); frame.id = 'legacy'; frame.sandbox.add('allow-scripts'); document.body.append(frame);
  const source = frame.contentWindow!;
  let guard: ReturnType<typeof createLegacyDocumentGuard> | null = null;
  const receiver = createLegacyReadOnlyReceiver({frame, source, session, live: () => state.live && (!guard || guard.isActive()),
    subscribe(request, deliver) {
      state.requests.push(request); state.deliveries.push(deliver);
      if (state.auto) setTimeout(() => {
        try {const event = verifyQueryEvent(state.auto, request.filters); deliver({type: 'relay.event', subId: request.subId, result: {event}});} catch { /* Filter mismatch is ordinary absence. */ }
        deliver({type: 'relay.eose', subId: request.subId});
      }, 0);
    }, close: request => state.closes.push(request), status: message => state.status.push(message)});
  state.receiver = receiver;
  if (guarded) {
    const NativeChannel = window.MessageChannel;
    window.MessageChannel = class extends NativeChannel {
      constructor() {super(); state.disconnectDocumentPort = () => this.port1.close(); window.MessageChannel = NativeChannel;}
    };
  }
  if (guarded) guard = createLegacyDocumentGuard(frame, source, session, () => {state.revoked++; state.live = false; receiver.destroy();}, () => state.resumed++);
  state.guard = guard;
  if (guard) frame.addEventListener('load', () => guard!.loaded());
  const receive = (event: MessageEvent) => {if (guard) guard.receive(event, receiver.receive); else receiver.receive(event);}; window.addEventListener('message', receive);
  const oldDestroy = receiver.destroy;
  state.destroy = () => {guard?.destroy(); oldDestroy(); window.removeEventListener('message', receive);};
  let projected = html.replace(/<head[^>]*>/i, match => match + `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
  projected = injectLegacyReadOnly(projected, session); if (recipe) projected = injectLegacyRecipeModules(projected);
  frame.srcdoc = projected;
}
(window as any).__legacy = state; state.mount = mount;

state.openNative = (): void => {
  state.native?.destroy(); state.nativeWire = []; state.nativeDeliveries = [];
  const listeners = new Set<(event: {data: unknown}) => void>();
  state.native = createNativeClient({postMessage: message => state.nativeWire.push(JSON.parse(message)),
    addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener)}, session);
  state.nativeReply = (message: unknown): void => {for (const listener of listeners) listener({data: JSON.stringify(message)});};
};
