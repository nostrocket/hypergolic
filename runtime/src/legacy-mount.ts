import {createLegacyDocumentGuard} from './legacy-lifecycle';
import {createLegacyReadOnlyReceiver} from './legacy-readonly';
import type {createNativeClient} from './native-client';

/** Presentation and adapter wiring for an already verified, explicitly selected profile. */
export function createLegacyMount(enabled: boolean, frame: HTMLIFrameElement, source: Window,
  native: ReturnType<typeof createNativeClient>, live: () => boolean, fail: () => void, active: () => void) {
  if (!enabled) return undefined;
  const nonce = crypto.randomUUID();
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Read-only compatibility · public relay reads only';
  status.style.cssText = 'margin:0;padding:8px 12px;font:12px system-ui;background:#17202a;color:#fff;flex:none';
  document.body.style.cssText = 'display:flex;flex-direction:column';
  frame.style.cssText = 'flex:1;min-height:0;height:auto';
  document.body.prepend(status);
  const guard = createLegacyDocumentGuard(frame, source, nonce, fail, active);
  const receiver = createLegacyReadOnlyReceiver({frame, source, session: nonce, live,
    subscribe: (request, deliver) => native.legacySubscribe(request, message => guard.run(() => deliver(message), new TextEncoder().encode(JSON.stringify(message)).length)),
    close: request => native.legacyClose(request),
    status: message => {status.textContent = 'Read-only compatibility · ' + message.slice(0,256);},
  });
  return {nonce, guard, receiver, close() {guard.destroy(); receiver.destroy(); status.remove();}};
}
