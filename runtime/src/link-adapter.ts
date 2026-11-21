import type { NappletMessage, ServiceHandler } from '@kehto/runtime';
import { NAPPLET_LINK_LEASE_MS, captureLinkResult, linkDenied, linkRequestId, parseLinkRequest } from '../../src/links/link-contract';
import { NativeRequestRevoked, type createNativeClient } from './native-client';
export function createLinkAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean): ServiceHandler {
  return {descriptor: {name: 'link', version: '1.0.0'}, handleMessage(_windowId, message, send) {
    const live = captureRecipient(), id = linkRequestId(message);
    if (id === null) return;
    let request;
    try {request = parseLinkRequest(message);} catch {if (live()) send(linkDenied(id, 'invalid-url') as NappletMessage); return;}
    // Napplet destinations stay in the shell. Ordinary web URLs use the native OS link opener.
    const handoff = request.url.startsWith('nostr:naddr1')
      ? native.request({type: 'routing.call', id: crypto.randomUUID(), message: request} as NappletMessage, undefined, NAPPLET_LINK_LEASE_MS + 3_000)
          .then(reply => 'response' in reply ? reply.response : undefined)
      : native.request(request as NappletMessage);
    void handoff.then(response => {
      if (live()) send(captureLinkResult(response, id) as NappletMessage);
    }).catch(error => {if (!(error instanceof NativeRequestRevoked) && live()) send(linkDenied(id) as NappletMessage);});
  }};
}
