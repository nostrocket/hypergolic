import { CLOSE_CHECK_SERVICE, CLOSE_CHECK_TIMEOUT_MS, type CloseState } from '../../src/shell/close-check';

/** Handles only a fixed trusted-host control and replies from its captured live guest. */
export function installCloseCheck(source: Window, live: () => boolean, report: (id: string, state: CloseState) => void): () => void {
  let pending: {id: string; deadline: number; timer: number} | null = null;
  const clear = () => { if (pending) window.clearTimeout(pending.timer); pending = null; };
  const finish = (state: CloseState) => {
    const captured = pending;
    clear();
    if (captured && live()) report(captured.id, performance.now() < captured.deadline ? state : 'unknown');
  };
  const receive = (event: MessageEvent) => {
    if (!event.isTrusted || !live()) return;
    const value = event.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (event.source === window && value.type === 'hypergolic.close-check.request' &&
        Object.keys(value).length === 2 && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.id)) {
      clear();
      pending = {id: value.id, deadline: performance.now() + CLOSE_CHECK_TIMEOUT_MS,
        timer: window.setTimeout(() => finish('unknown'), CLOSE_CHECK_TIMEOUT_MS)};
      // The sandbox has an opaque origin; only this WindowProxy is a recipient.
      source.postMessage({type: 'hypergolic.closeCheck', id: value.id}, '*');
    } else if (event.source === source && pending && value.type === 'hypergolic.closeCheck.result' && value.id === pending.id) {
      finish(Object.keys(value).length === 3 && ['clean', 'dirty', 'unknown'].includes(value.state) ? value.state : 'unknown');
    }
  };
  window.addEventListener('message', receive);
  return () => { clear(); window.removeEventListener('message', receive); };
}

export { CLOSE_CHECK_SERVICE };
