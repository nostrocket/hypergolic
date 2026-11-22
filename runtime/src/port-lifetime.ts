import type {GuestBindingTransport} from './guest-port';

/** Installed by the shell before publisher code in a private-port guest. */
export function installPortLiveness(wire: GuestBindingTransport): void {
  wire.listen(value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'hypergolic.port.ping' &&
        'id' in value && typeof value.id === 'string') wire.send({type:'hypergolic.port.pong', id:value.id});
  });
}

/** Some WebViews do not emit a close event when the other end disconnects. */
export function observePortLifetime(port: MessagePort, ended: () => void): () => void {
  port.addEventListener('close', ended);
  const interval = 10_000;
  let pending = '', sent = 0;
  const reset = () => { pending = ''; };
  const received = (event: MessageEvent) => {
    if (event.isTrusted && event.data?.type === 'hypergolic.port.pong' && event.data.id === pending) reset();
  };
  const check = () => {
    if (document.hidden) { reset(); return; }
    const now = performance.now();
    // Give a suspended event loop a fresh round trip when it resumes.
    if (pending && now - sent < interval * 2) { ended(); return; }
    pending = crypto.randomUUID();
    sent = now;
    port.postMessage({type:'hypergolic.port.ping', id:pending});
  };
  const timer = 'onclose' in port ? undefined : window.setInterval(check, interval);
  port.addEventListener('message', received);
  document.addEventListener('visibilitychange', reset);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', reset);
    port.removeEventListener('message', received);
    port.removeEventListener('close', ended);
  };
}
