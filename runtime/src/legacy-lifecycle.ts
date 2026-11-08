const READY = 'hypergolic.legacy.document.ready';
const PORT = 'hypergolic.legacy.document.port';
const MAX_QUEUED = 32, MAX_BYTES = 256 * 1024, TIMEOUT_MS = 1000, INITIAL_TIMEOUT_MS = 10_000;
/** A private port belongs to the original Document, unlike its navigation-stable WindowProxy. */
export function createLegacyDocumentGuard(frame: HTMLIFrameElement, source: Window, session: string,
  revoke: () => void, active: () => void) {
  let state: 'starting' | 'active' | 'checking' | 'closed' = 'starting';
  let port: MessagePort | null = null, challenge = '', loaded = false, probeAfterStart = false;
  let bytes = 0;
  const queue: Array<() => void> = [];
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')!.get!;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
  let timer = window.setTimeout(fail, INITIAL_TIMEOUT_MS);
  function destroy(): void {
    if (state === 'closed') return;
    state = 'closed'; window.clearTimeout(timer); port?.close(); port = null; queue.length = 0; bytes = 0;
  }
  function fail(): void {if (state === 'closed') return; destroy(); revoke();}
  function run(action: () => void, size: number): void {
    if (state === 'closed' || frame.contentWindow !== source) return;
    if (state === 'active') {action(); return;}
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || queue.length >= MAX_QUEUED || bytes + size > MAX_BYTES) {fail(); return;}
    bytes += size; queue.push(action);
  }
  function resume(): void {
    if (state === 'closed') return;
    window.clearTimeout(timer); state = 'active';
    const pending = queue.splice(0); bytes = 0;
    for (const action of pending) {if (state !== 'active') break; action();}
    if (state === 'active' && loaded) active();
  }
  function probe(): void {
    if (!port || state === 'closed') {fail(); return;}
    state = 'checking'; challenge = crypto.randomUUID(); window.clearTimeout(timer);
    timer = window.setTimeout(fail, TIMEOUT_MS);
    try {port.postMessage({type: 'ping', challenge});} catch {fail();}
  }
  function connect(): void {
    if (port || state !== 'starting') return;
    const channel = new MessageChannel(); port = channel.port1; challenge = crypto.randomUUID();
    port.onmessage = event => {
      if (state === 'closed' || !event.isTrusted) return;
      const value = event.data;
      if (value?.type === 'revoke' && Object.keys(value).length === 1) {fail(); return;}
      if (!value || Object.keys(value).length !== 2 || value.challenge !== challenge ||
          (state === 'starting' ? value.type !== 'ready' : state !== 'checking' || value.type !== 'pong')) return;
      if (state === 'starting' && probeAfterStart) {probe(); return;}
      resume();
    };
    port.start();
    try {source.postMessage({type: PORT, session, challenge}, '*', [channel.port2]);} catch {channel.port2.close(); fail();}
  }
  function receive(event: MessageEvent, dispatch: (event: MessageEvent) => void): void {
    if (state === 'closed' || !event.isTrusted || frame.contentWindow !== source || Reflect.apply(sourceGetter, event, []) !== source) return;
    const value = Reflect.apply(dataGetter, event, []);
    if (value?.type === READY) {
      for (const incoming of event.ports) incoming.close();
      if (value.session === session && Object.keys(value).length === 2) connect();
      return;
    }
    let size: number;
    try {size = new TextEncoder().encode(JSON.stringify(value)).length;} catch {fail(); return;}
    run(() => dispatch(event), size);
  }
  return Object.freeze({receive, run, destroy, isActive: () => state === 'active', loaded() {
    if (state === 'closed') return;
    if (!loaded) {loaded = true; if (state === 'active') active(); return;}
    if (state === 'starting') {probeAfterStart = true; return;}
    if (state === 'checking') {fail(); return;}
    probe();
  }});
}
