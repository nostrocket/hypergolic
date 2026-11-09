import { CATALOG_PAGE } from '../../src/napplets/catalog-page-contract';
import { DISCOVERY_OPEN } from '../../src/napplets/discovery-open-contract';
import type { createCatalogPageReceiver } from './discovery-catalog';
import type { createDiscoveryOpenReceiver } from './discovery-open';
import type { createGuestRouting } from './intent-delivery';
import { isKeysMessage, type createKeysSession } from './keys-adapter';
import { mediaRequestId, projectMediaRequest } from './media-wire';
import type { createNativeClient } from './native-client';

type GuestMessageRoutes = Readonly<{
  routing: ReturnType<typeof createGuestRouting>;
  discoveryOpen: ReturnType<typeof createDiscoveryOpenReceiver> | null;
  catalogPage: ReturnType<typeof createCatalogPageReceiver> | null;
  keys: ReturnType<typeof createKeysSession> | null;
  sendMedia: ReturnType<typeof createNativeClient>['sendMedia'] | null;
  cvm?:((value:unknown)=>void)|null;
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
    if (++operations > 64) {
      for (const port of event.ports) port.close();
      return;
    }
    if (routes.routing.connect(event)) return;
    if (event.data?.type === DISCOVERY_OPEN) {
      routes.discoveryOpen?.(event.data);
      return;
    }
    if (event.data?.type === CATALOG_PAGE) {
      routes.catalogPage?.(event.data);
      return;
    }
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
