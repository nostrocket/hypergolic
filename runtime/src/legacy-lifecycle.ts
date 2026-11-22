import {observePortLifetime} from './port-lifetime';
const MAX_QUEUED = 32, MAX_BYTES = 256 * 1024, TIMEOUT_MS = 1000, INITIAL_TIMEOUT_MS = 10_000;
/** A private port belongs to the original Document, unlike its navigation-stable WindowProxy. */
export function createLegacyDocumentGuard(frame: HTMLIFrameElement, source: Window, session: string,
  revoke: () => void, active: () => void) {
  let state: 'starting' | 'active' | 'checking' | 'closed' = 'starting';
  let port: MessagePort | null = null, challenge = '', loaded = false, probeAfterStart = false;
  let stopObserving: (() => void) | undefined;
  let bytes = 0, operations = 0, started = performance.now();
  const queue: Array<() => void> = [];
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')!.get!;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
  let timer = window.setTimeout(fail, INITIAL_TIMEOUT_MS);
  function destroy(): void {
    if (state === 'closed') return;
    state = 'closed'; window.clearTimeout(timer);
    if (port) {
      stopObserving?.();
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      port = null;
    }
    queue.length = 0; bytes = 0;
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
  function connect(connection: MessagePort, dispatch: (value: Record<string, unknown>) => void): void {
    port = connection; challenge = crypto.randomUUID();
    stopObserving = observePortLifetime(port, fail);
    port.onmessageerror = fail;
    port.onmessage = event => {
      if (state === 'closed' || !event.isTrusted || event.origin !== '') return;
      if (event.ports.length) {for (const unused of event.ports) unused.close(); return;}
      const value = event.data;
      if (value?.type === 'revoke' && Object.keys(value).length === 1) {fail(); return;}
      if ((value?.type === 'legacy.readonly' || value?.type === 'legacy.image') && value.session === session) {
        const now = performance.now();
        if (now - started > 1000) {started = now; operations = 0;}
        if (++operations > 64) return;
        let size: number;
        try {size = new TextEncoder().encode(JSON.stringify(value)).length;} catch {fail(); return;}
        run(() => dispatch(value), size);
        return;
      }
      if (!value || value.challenge !== challenge) return;
      if (state === 'starting') {
        if (value.type !== 'ready' || value.session !== session || Object.keys(value).length !== 3) return;
      } else if (state !== 'checking' || value.type !== 'pong' || Object.keys(value).length !== 2) return;
      if (state === 'starting' && probeAfterStart) {probe(); return;}
      resume();
    };
    port.start();
    try {port.postMessage({type:'identify', challenge});} catch {fail();}
  }
  function receive(event: MessageEvent, dispatch: (value: Record<string, unknown>) => void): void {
    if (state === 'closed' || !event.isTrusted || frame.contentWindow !== source || Reflect.apply(sourceGetter, event, []) !== source) return;
    const value = Reflect.apply(dataGetter, event, []);
    if (event.origin === 'null' && state === 'starting' && !port && value?.type === 'napplet.hello' &&
        Object.keys(value).length === 1 && event.ports.length === 1) {
      connect(event.ports[0]!, dispatch);
    } else {
      for (const unused of event.ports) unused.close();
      if (port) fail();
    }
  }
  return Object.freeze({receive, run, destroy, send(value: object) {
    if (state === 'active' && frame.contentWindow === source) port?.postMessage(value);
  }, isActive: () => state === 'active', navigate(hash: string) {
    if (state !== 'active' || frame.contentWindow !== source || !port || !/^#\/post\/naddr1[0-9a-z]{1,1800}$/.test(hash)) throw new Error('Article reader is not active');
    port.postMessage({type: 'navigate', hash});
  }, refreshRecipeFeed() {
    if (state !== 'active' || frame.contentWindow !== source || !port) throw new Error('Recipe reader is not active');
    port.postMessage({type: 'recipe-feed'});
  }, loaded() {
    if (state === 'closed') return;
    if (!loaded) {loaded = true; if (state === 'active') active(); return;}
    if (state === 'starting') {probeAfterStart = true; return;}
    if (state === 'checking') {fail(); return;}
    probe();
  }});
}
