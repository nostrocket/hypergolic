import { quotaReply } from './guest-envelope';
import type { createGuestRouting } from './intent-delivery';
import { isKeysMessage, type createKeysSession } from './keys-adapter';
import { mediaRequestId, projectMediaRequest } from './media-wire';
import type { createNativeClient } from './native-client';

type GuestMessageRoutes = Readonly<{
  domains: readonly string[];
  routing: ReturnType<typeof createGuestRouting>;
  keys: ReturnType<typeof createKeysSession> | null;
  sendMedia: ReturnType<typeof createNativeClient>['sendMedia'] | null;
  cvm?:((value:unknown)=>void)|null;
  account?(): string | undefined;
  closed(): boolean;
  live(): boolean;
  dispatch(event: MessageEvent): void;
}>;
export function guestMessageReceiver(frame: HTMLIFrameElement, source: Window, routes: GuestMessageRoutes) {
  let operations = 0;
  let windowStart = performance.now();
  return (event: MessageEvent): void => {
    if (routes.closed() || !event.isTrusted || event.source !== source || frame.contentWindow !== source) return;
    if (performance.now() - windowStart > 1000) { operations = 0; windowStart = performance.now(); }
    const type = event.data?.type;
    const cleanup = type === 'relay.close' || type === 'outbox.close' || type === 'resource.cancel';
    if (++operations > 64 && (!cleanup || event.ports.length)) {
      for (const port of event.ports) port.close();
      const reply = routes.live() && !event.ports.length && quotaReply(event.data, routes.domains, 'quota-exceeded', routes.account?.());
      if (reply) source.postMessage(reply, '*');
      return;
    }
    if (routes.routing.connect(event)) return;
    if (isKeysMessage(event.data)) {
      if (routes.live()) routes.keys?.receive(event.data);
      return;
    }
    if (routes.sendMedia && routes.live() && typeof event.data?.type === 'string' && event.data.type.startsWith('media.')) {
      const request = projectMediaRequest(event.data);
      if (request && routes.sendMedia(request)) return;
      if (event.data.type === 'media.session.create') {
        const id = mediaRequestId(event.data.id);
        if (id) source.postMessage({type:'media.session.create.result', id, error:'Unsupported media request.'}, '*');
      }
      return;
    }
    if(typeof event.data?.type==='string'&&event.data.type.startsWith('cvm.')){routes.cvm?.(event.data);return;}
    routes.dispatch(event);
  };
}
