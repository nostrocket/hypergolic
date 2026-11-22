import {installLegacyImages} from './legacy-image-guest';

/** Host-supplied read-only compatibility prelude. It grants no ordinary NAP authority. */
function createLegacyDocumentPort(session: string, closed: () => boolean, receive: (value: Record<string, unknown>) => void) {
  const channel = new MessageChannel();
  const port = channel.port1;
  const send = port.postMessage.bind(port), close = port.close.bind(port);
  const dataOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
  const apply = Reflect.apply, query = Document.prototype.querySelector, click = HTMLElement.prototype.click;
  port.addEventListener('message', event => {
    if (!event.isTrusted || closed()) return;
    const value = apply(dataOf, event, []);
    if (typeof value?.challenge === 'string' && value.challenge.length <= 128 && Object.keys(value).length === 2) {
      if (value.type === 'identify') send({type:'ready', session, challenge:value.challenge});
      if (value.type === 'ping') send({type:'pong', challenge:value.challenge});
    }
    if (value?.type === 'navigate' && typeof value.hash === 'string' && /^#\/post\/naddr1[0-9a-z]{1,1800}$/.test(value.hash) && Object.keys(value).length === 2)
      location.hash = value.hash;
    if (value?.type === 'legacy.image.result' || value?.type === 'legacy.readonly.result') receive(value);
    if (value?.type === 'recipe-feed' && Object.keys(value).length === 1) {
      const feed = apply(query, document, ['button[data-view="feed"]']);
      if (feed instanceof HTMLElement) apply(click, feed, []);
    }
  });
  port.start();
  window.parent.postMessage({type:'napplet.hello'}, '*', [channel.port2]);
  return {send, revoke() {send({type:'revoke'}); close();}};
}
function installLegacyReadOnly(session: string, documentFactory: typeof createLegacyDocumentPort, imageFactory: typeof installLegacyImages): void {
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
  const sockets = new Map<string, ReadSocket>();
  let sequence = 0, dead = false;
  const documentPort = documentFactory(session, () => dead, row => {
    if (row.session !== session || dead) return;
    if (row.type === 'legacy.image.result') receiveImage(row);
    else if (typeof row.socket === 'string') sockets.get(row.socket)?.deliver(row);
  });
  const receiveImage = imageFactory(session, documentPort.send);
  const send = (operation: string, fields: object): void => documentPort.send({type:'legacy.readonly', session, operation, ...fields});
  class ReadSocket extends EventTarget {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
    readonly url: string; readonly protocol = ''; readonly extensions = ''; readonly bufferedAmount = 0;
    binaryType: BinaryType = 'blob';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private id: string;
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (dead || sequence >= 4096 || sockets.size >= 4 || protocols !== undefined && (!Array.isArray(protocols) || protocols.length !== 0)) throw new DOMException('Legacy read-only socket unavailable', 'SecurityError');
      const value = new URL(String(url));
      if (value.protocol !== 'wss:' || value.username || value.password || value.hash || value.search || value.port && value.port !== '443') throw new DOMException('Legacy relay denied', 'SecurityError');
      this.url = value.href; this.id = 'socket-' + (++sequence); sockets.set(this.id, this);
      send('open', {socket: this.id, url: this.url});
    }
    emit(event: Event): void {
      this.dispatchEvent(event);
      const handler = event.type === 'message' ? this.onmessage : event.type === 'open' ? this.onopen : event.type === 'error' ? this.onerror : this.onclose;
      if (handler) try { (handler as (event: Event) => void).call(this, event); } catch { /* Guest callbacks are independent. */ }
    }
    deliver(row: Record<string, unknown>): void {
      if (this.readyState === 3) return;
      if (row.event === 'open' && this.readyState === 0) {this.readyState = 1; this.emit(new Event('open'));}
      else if (row.event === 'message' && this.readyState === 1 && typeof row.data === 'string' && row.data.length <= 70000) this.emit(new MessageEvent('message', {data: row.data}));
      else if (row.event === 'close') {this.readyState = 3; sockets.delete(this.id); this.emit(new CloseEvent('close', {code: 1008, reason: typeof row.reason === 'string' ? row.reason.slice(0, 123) : 'Read-only socket closed', wasClean: false}));}
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== 1) throw new DOMException('Socket is not open', 'InvalidStateError');
      if (typeof data !== 'string' || data.length > 16384) throw new DOMException('Legacy read-only frames must be bounded text', 'SecurityError');
      let frame: unknown;
      try {frame = parse(data);} catch {throw new DOMException('Invalid legacy read frame', 'SecurityError');}
      if (!Array.isArray(frame) || !['REQ', 'CLOSE'].includes(frame[0]) || frame[0] === 'CLOSE' && frame.length !== 2 || frame[0] === 'REQ' && (frame.length < 3 || frame.length > 6)) throw new DOMException('Legacy mode permits REQ/CLOSE only; signing, publishing and AUTH are denied', 'SecurityError');
      send('send', {socket: this.id, data: stringify(frame)});
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3; sockets.delete(this.id); send('close', {socket: this.id});
      this.emit(new CloseEvent('close', {code: 1000, wasClean: true}));
    }
  }
  window.addEventListener('pagehide', event => {
    if (!event.isTrusted) return;
    dead = true; documentPort.revoke();
    for (const socket of sockets.values()) socket.close(); sockets.clear();
  }, true);
  // NIP-07 is deliberately absent. Publishing remains impossible even with a guest-created key.
  Object.defineProperty(window, 'WebSocket', {value: ReadSocket, writable: false, configurable: false});
}

/** Insert after the host CSP and before every signed-guest script; original bytes are verified first. */
export function injectLegacyReadOnly(html: string, session: string): string {
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(session)) throw new Error('Invalid legacy session');
  const encoded = JSON.stringify(session).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const source = '(' + installLegacyReadOnly.toString() + ')(' + encoded + ',(' + createLegacyDocumentPort.toString() + '),(' + installLegacyImages.toString() + '));';
  const prelude = '<script>' + source.replaceAll('</script', '<\\/script') + '</script>';
  const cspEnd = html.indexOf('>', html.indexOf('<meta http-equiv="Content-Security-Policy"'));
  if (cspEnd < 0 || !html.includes('<meta http-equiv="Content-Security-Policy"')) throw new Error('Legacy prelude requires host CSP');
  return html.slice(0, cspEnd + 1) + prelude + html.slice(cspEnd + 1);
}

/** The exact reviewed Longform hero sits outside its responsive Markdown image selector. */
export function injectLegacyLongformLayout(html: string): string {
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw new Error('Legacy layout requires host CSP');
  return html.replace(head, value => value + '<style id="legacy-longform-layout">article.card > img.md-img{max-width:100%;height:auto}</style>');
}
