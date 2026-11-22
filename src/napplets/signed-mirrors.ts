import { NappletHashMismatchError, NappletHtmlEnvelopeError } from './verified-artifact.ts';

const HEDGE_DELAY_MS = 750;

/** Two authorized reads at most, one deadline for all signed origins. Only verified results can win. */
export function readSignedMirrors<T>(urls: readonly string[], timeoutMs: number, parent: AbortSignal,
  read: (url: string, signal: AbortSignal, progress: () => void) => Promise<T>, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const active = new Map<AbortController, () => void>();
    let next = 0, finished = false, mismatch: NappletHashMismatchError | undefined;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop(), timeoutMs);
    function close(): void {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(hedge);
      parent.removeEventListener('abort', stop);
      for (const cancel of active.values()) cancel();
      active.clear();
    }
    function stop(): void {
      if (finished) return;
      close();
      reject(mismatch ?? new Error('The signed mirrors were unavailable'));
    }
    function armHedge(): void {
      clearTimeout(hedge);
      if (!finished && active.size === 1 && next < urls.length) hedge = setTimeout(start, HEDGE_DELAY_MS);
    }
    function start(): void {
      if (finished || next >= urls.length) return;
      const controller = new AbortController();
      const index = next++, url = urls[index]!;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { clearTimeout(idle); controller.abort(); };
      const progress = () => {
        if (finished || controller.signal.aborted) return;
        armHedge();
        if (index === 0 || next >= urls.length) return;
        clearTimeout(idle);
        // Keep the preferred mirror available while stalled fallback reads make room for later origins.
        idle = setTimeout(() => {
          if (!active.delete(controller)) return;
          cancel();
          start();
        }, Math.max(HEDGE_DELAY_MS, Math.floor(timeoutMs / urls.length)));
      };
      active.set(controller, cancel);
      progress();
      const attempt = async () => {
        try {
          const value = await read(url, controller.signal, progress);
          const current = active.delete(controller);
          if (!current || finished) { discard?.(value); return; }
          close();
          resolve(value);
        } catch (error) {
          if (!active.delete(controller) || finished) return;
          if (error instanceof NappletHtmlEnvelopeError) { close(); reject(error); return; }
          if (error instanceof NappletHashMismatchError) mismatch = error;
          if (next < urls.length) start();
          else if (!active.size) stop();
        } finally { clearTimeout(idle); }
      };
      void attempt();
    }
    parent.addEventListener('abort', stop, { once: true });
    if (parent.aborted || !urls.length) stop(); else start();
  });
}
