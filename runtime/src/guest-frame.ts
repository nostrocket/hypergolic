import type { bindResourceMedia } from './resource-media';
import type { createLegacyDocumentGuard } from './legacy-lifecycle';

export function createGuestFrame(title: string): HTMLIFrameElement {
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

export function createLoadHandler(frame: HTMLIFrameElement, source: Window,
  media: ReturnType<typeof bindResourceMedia>, legacyGuard: ReturnType<typeof createLegacyDocumentGuard> | undefined,
  failed: () => void): () => void {
  let frameLoaded = false;
  return (): void => {
    if (source.length > 0) { failed(); return; }
    // A same-document legacy load must prove ownership of the original private port.
    if (legacyGuard) {legacyGuard.loaded(); media.refresh(); return;}
    if (frameLoaded) {failed(); return;}
    frameLoaded = true;
    media.refresh();
    if (frame.contentWindow !== source) failed();
  };
}

export function bindFrameListeners(frame: HTMLIFrameElement, source: Window,
  legacyGuard: ReturnType<typeof createLegacyDocumentGuard> | undefined,
  receiveGuest: (event: MessageEvent) => void, loaded: () => void, failed: () => void) {
  const receive = (event: MessageEvent): void => {
    if (event.isTrusted && (source.length > 0 || event.data?.type === 'hypergolic.nested-document')) {
      failed();
      return;
    }
    if (legacyGuard) legacyGuard.receive(event, receiveGuest);
    else receiveGuest(event);
  };
  window.addEventListener('message', receive);
  frame.addEventListener('load', loaded);
  return () => {
    window.removeEventListener('message', receive);
    frame.removeEventListener('load', loaded);
  };
}
