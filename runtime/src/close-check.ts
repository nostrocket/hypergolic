import { CLOSE_CHECK_SERVICE, CLOSE_CHECK_TIMEOUT_MS, type CloseState } from '../../src/shell/close-check';

/** Handles only a fixed trusted-host control and replies from its captured live guest. */
export function installCloseCheck(source: Window, live: () => boolean, report: (id: string, state: CloseState) => void, checkpoint?: Readonly<{idle(): boolean; send(message: object): void}>) {
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
      const restore = value.id.startsWith('restore-'), save = value.id.startsWith('resume-');
      const timeout = restore ? 15_000 : save ? 1_500 : CLOSE_CHECK_TIMEOUT_MS;
      pending = {id: value.id, deadline: performance.now() + timeout,
        timer: window.setTimeout(() => finish('unknown'), timeout)};
      if (save || restore) {
        if (!checkpoint || (save && !checkpoint.idle())) {finish('unknown'); return;}
        checkpoint.send({type: restore ? 'hypergolic.restoreCheckpoint' : 'hypergolic.checkpoint',
          id: restore ? value.id.replace('restore-', 'resume-') : value.id});
      } else source.postMessage({type:'hypergolic.closeCheck', id:value.id}, '*');
    } else if (event.source === source && pending && !pending.id.startsWith('resume-') && !pending.id.startsWith('restore-') &&
        value.type === 'hypergolic.closeCheck.result' && value.id === pending.id) {
      finish(Object.keys(value).length === 3 && ['clean', 'dirty', 'unknown'].includes(value.state) ? value.state : 'unknown');
    }
  };
  window.addEventListener('message', receive);
  return {
    checkpointResult(value: Record<string, unknown>) {
      if (!live() || !pending || !checkpoint) return;
      const exact = Object.keys(value).length === 3;
      if (pending.id.startsWith('resume-') && value.type === 'hypergolic.checkpoint.result' && value.id === pending.id) {
        finish(exact && value.state === 'saved' && checkpoint.idle() ? 'clean' : 'unknown');
      } else if (pending.id.startsWith('restore-') && value.type === 'hypergolic.restoreCheckpoint.result' &&
          value.id === pending.id.replace('restore-', 'resume-')) finish(exact && value.state === 'restored' ? 'clean' : 'unknown');
    },
    close() { clear(); window.removeEventListener('message', receive); },
  };
}

export { CLOSE_CHECK_SERVICE };
