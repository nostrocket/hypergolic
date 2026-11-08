/** Legacy img src properties/attributes use the private image lane; direct network stays CSP-blocked. */
function installLegacyImages(session: string): void {
  const parentWindow = window.parent, post = parentWindow.postMessage.bind(parentWindow), apply = Reflect.apply;
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')!.get!;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')!.get!;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  const setSource = descriptor.set!, createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
  const NativeURL = URL, dispatch = EventTarget.prototype.dispatchEvent, ImageEvent = Event, defer = queueMicrotask.bind(window);
  const NativeBlob = Blob, encoder = new TextEncoder();
  const setAttribute = Element.prototype.setAttribute;
  type ImageWork = {image: HTMLImageElement; id: string; url: string; revision: number; started: boolean; objectURL?: string; done: boolean};
  const images = new Map<string, ImageWork>(), selected = new WeakMap<HTMLImageElement, ImageWork>();
  const revisions = new WeakMap<HTMLImageElement, number>();
  let sequence = 0, inFlight = 0, dead = false;
  const send = (operation: string, work: ImageWork): void => post({type: 'legacy.image', session, operation, id: work.id,
    ...(operation === 'bytes' ? {url: work.url} : {})}, '*');
  const attached = (work: ImageWork): boolean => apply(connected, work.image, []) && selected.get(work.image) === work;
  const release = (work: ImageWork): void => {
    if (images.get(work.id) !== work) return;
    images.delete(work.id); selected.delete(work.image);
    if (work.objectURL) revokeURL(work.objectURL);
    if (work.started && !work.done) {inFlight--; send('cancel', work);}
    work.done = true;
  };
  const pump = (): void => {
    if (dead) return;
    for (const work of images.values()) {
      if (!attached(work)) {release(work); continue;}
      if (!work.started && inFlight < 2) {work.started = true; inFlight++; send('bytes', work);}
    }
  };
  const failure = (work: ImageWork): void => {
    const image = work.image; release(work);
    // Preserve the original guest's fallback handlers, installed after its src assignment.
    defer(() => {if (!dead && revisions.get(image) === work.revision) apply(dispatch, image, [new ImageEvent('error')]);});
  };
  const assign = (image: HTMLImageElement, value: unknown): void => {
    const revision = (revisions.get(image) ?? 0) + 1; revisions.set(image, revision);
    const previous = selected.get(image); if (previous) release(previous);
    const raw = String(value);
    if (!/^https?:/i.test(raw)) {apply(setSource, image, [raw]); defer(pump); return;}
    // A blocked remote-src error would trigger publisher fallback before native bytes arrive.
    if (dead) return;
    const work: ImageWork = {image, id: 'image-' + (++sequence), url: raw, revision, started: false, done: false};
    if (images.size >= 64 || sequence > 1024 || raw.length > 8192) {
      defer(() => {if (!dead && revisions.get(image) === revision) apply(dispatch, image, [new ImageEvent('error')]);}); return;
    }
    images.set(work.id, work); selected.set(image, work);
    try {
      const url = new NativeURL(raw);
      if (url.protocol !== 'https:' || encoder.encode(url.href).byteLength > 8192) throw new Error('Bounded HTTPS image required');
      work.url = url.href;
    } catch {failure(work); return;}
    defer(pump);
  };
  Object.defineProperty(HTMLImageElement.prototype, 'src', {configurable: false, enumerable: descriptor.enumerable === true,
    get: descriptor.get!, set(this: HTMLImageElement, value: unknown) {assign(this, value);}});
  Object.defineProperty(Element.prototype, 'setAttribute', {configurable: false, writable: false,
    value(this: Element, name: unknown, value: unknown): void {
      const attribute = String(name);
      if (this instanceof HTMLImageElement && attribute.toLowerCase() === 'src') {assign(this, value); return;}
      apply(setAttribute, this, [attribute, value]);
    }});
  const observer = new MutationObserver(pump);
  observer.observe(document, {childList: true, subtree: true});
  window.addEventListener('message', event => {
    if (dead || !event.isTrusted || apply(sourceGetter, event, []) !== parentWindow) return;
    const value = apply(dataGetter, event, []);
    if (value?.type !== 'legacy.image.result' || value.session !== session || typeof value.id !== 'string') return;
    const work = images.get(value.id);
    if (!work || !work.started || work.done) return;
    inFlight--; work.done = true;
    if (!attached(work)) {release(work); pump(); return;}
    if (Object.keys(value).length !== 5 || !(value.blob instanceof NativeBlob) || value.blob.size > 10 * 1024 * 1024 ||
      !['image/png', 'image/gif', 'image/jpeg', 'image/webp'].includes(value.mime) || value.blob.type !== value.mime) {
      failure(work); pump(); return;
    }
    work.objectURL = createURL(value.blob); apply(setSource, work.image, [work.objectURL]); pump();
  });
  window.addEventListener('pagehide', event => {
    if (!event.isTrusted) return;
    dead = true; observer.disconnect(); for (const work of images.values()) release(work);
  }, true);
}
export function injectLegacyImages(html: string, session: string): string {
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(session)) throw new Error('Invalid legacy image session');
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw new Error('Legacy images require host CSP');
  const encoded = JSON.stringify(session).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return html.replace(head, value => value + '<script>(' + installLegacyImages.toString() + ')(' + encoded + ');</script>');
}
