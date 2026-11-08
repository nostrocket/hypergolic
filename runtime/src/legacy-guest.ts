/** Host-supplied read-only compatibility prelude. It grants no ordinary NAP authority. */
function createLegacyDocumentPort(session: string, closed: () => boolean) {
  const parentWindow = window.parent, apply = Reflect.apply;
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  const stop = Event.prototype.stopImmediatePropagation;
  const portsGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')?.get;
  const portPost = MessagePort.prototype.postMessage, portStart = MessagePort.prototype.start, portClose = MessagePort.prototype.close;
  const portListen = EventTarget.prototype.addEventListener;
  let documentPort: MessagePort | null = null;
  window.addEventListener('message', event => {
    if (!event.isTrusted || !sourceGetter || !dataGetter || apply(sourceGetter, event, []) !== parentWindow) return;
    const value = apply(dataGetter, event, []);
    if (value?.type !== 'hypergolic.legacy.document.port' || value.session !== session) return;
    apply(stop, event, []);
    if (!portsGetter) return;
    const ports = apply(portsGetter, event, []) as readonly MessagePort[];
    if (documentPort || Object.keys(value).length !== 3 || typeof value.challenge !== 'string' || ports.length !== 1) {
      for (const port of ports) apply(portClose, port, []); return;
    }
    documentPort = ports[0]!;
    apply(portListen, documentPort, ['message', (event: MessageEvent) => {
      if (!event.isTrusted || closed()) return;
      const value = apply(dataGetter, event, []);
      if (value?.type === 'ping' && typeof value.challenge === 'string' && value.challenge.length <= 128 && Object.keys(value).length === 2)
        if (documentPort) apply(portPost, documentPort, [{type: 'pong', challenge: value.challenge}]);
    }]);
    apply(portStart, documentPort, []); apply(portPost, documentPort, [{type: 'ready', challenge: value.challenge}]);
  }, true);
  return {revoke() {if (documentPort) {apply(portPost, documentPort, [{type: 'revoke'}]); apply(portClose, documentPort, []);} documentPort = null;}};
}
function installLegacyReadOnly(session: string, documentFactory: typeof createLegacyDocumentPort): void {
  const parentWindow = window.parent, post = parentWindow.postMessage.bind(parentWindow);
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON), apply = Reflect.apply;
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  const documentPort = documentFactory(session, () => dead);
  const sockets = new Map<string, ReadSocket>();
  let sequence = 0, dead = false;
  const send = (operation: string, fields: object): void => post({type: 'legacy.readonly', session, operation, ...fields}, '*');
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
  window.addEventListener('message', event => {
    if (dead || !event.isTrusted || !sourceGetter || !dataGetter) return;
    try {
      if (apply(sourceGetter, event, []) !== parentWindow) return;
      const row = apply(dataGetter, event, []) as Record<string, unknown>;
      if (row?.type !== 'legacy.readonly.result' || row.session !== session || typeof row.socket !== 'string') return;
      sockets.get(row.socket)?.deliver(row);
    } catch { /* Invalid senders and replies have no destination. */ }
  });
  window.addEventListener('pagehide', event => {
    if (!event.isTrusted) return;
    dead = true; documentPort.revoke();
    for (const socket of sockets.values()) socket.close(); sockets.clear();
  }, true);
  // NIP-07 is deliberately absent. Publishing remains impossible even with a guest-created key.
  Object.defineProperty(window, 'WebSocket', {value: ReadSocket, writable: false, configurable: false});
  post({type: 'hypergolic.legacy.document.ready', session}, '*');
}

/** Insert after the host CSP and before every signed-guest script; original bytes are verified first. */
export function injectLegacyReadOnly(html: string, session: string): string {
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(session)) throw new Error('Invalid legacy session');
  const encoded = JSON.stringify(session).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const source = '(' + installLegacyReadOnly.toString() + ')(' + encoded + ',(' + createLegacyDocumentPort.toString() + '));';
  const prelude = '<script>' + source.replaceAll('</script', '<\\/script') + '</script>';
  const cspEnd = html.indexOf('>', html.indexOf('<meta http-equiv="Content-Security-Policy"'));
  if (cspEnd < 0 || !html.includes('<meta http-equiv="Content-Security-Policy"')) throw new Error('Legacy prelude requires host CSP');
  return html.slice(0, cspEnd + 1) + prelude + html.slice(cspEnd + 1);
}
