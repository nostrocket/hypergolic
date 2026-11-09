import type { NappletMessage } from '@kehto/runtime';

type Waiting = { message: NappletMessage; owner: string; bytes: number; deadline: number; timer: number; assertActive(): void;
  resolve(value: NappletMessage): void; reject(error: Error): void };
const unavailable = () => new Error('Native capability unavailable');
/** Resource work waits for the existing ordinary lane; it never reserves a native slot while queued. */
export function createResourceAdmission(available: () => boolean, post: (message: NappletMessage, remainingMs: number) => Promise<NappletMessage>) {
  const waiting: Waiting[] = [], active = new Set<Waiting>();
  let stopped = false, draining = false, bytes = 0;
  const remove = (work: Waiting): void => {
    waiting.splice(waiting.indexOf(work), 1); bytes -= work.bytes; window.clearTimeout(work.timer);
  };
  const drain = (): void => {
    if (stopped || draining) return;
    draining = true;
    try {
      while (waiting.length && available()) {
        const work = waiting[0]!; remove(work);
        const remaining = work.deadline - performance.now();
        if (remaining <= 0) { work.reject(unavailable()); continue; }
        active.add(work);
        try {
          work.assertActive();
          void post(work.message, remaining).then(work.resolve, work.reject).finally(() => { active.delete(work); drain(); });
        } catch { active.delete(work); work.reject(unavailable()); }
      }
    } finally { draining = false; }
  };
  return {
    released: drain,
    request(message: NappletMessage, owner: string, timeoutMs: number, assertActive: () => void = () => {}): Promise<NappletMessage> {
      if (stopped) return Promise.reject(unavailable());
      const captured = JSON.stringify(message), size = new TextEncoder().encode(captured).length;
      if (waiting.length >= 16 || size > 256 * 1024 - bytes) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        const work: Waiting = {message: JSON.parse(captured), owner, bytes: size, deadline: performance.now() + timeoutMs,
          timer: 0, resolve, reject, assertActive};
        work.timer = window.setTimeout(() => { remove(work); reject(unavailable()); drain(); }, timeoutMs);
        waiting.push(work); bytes += size; drain();
      });
    },
    cancel(owner: string): boolean {
      const owned = waiting.filter(work => work.owner === owner);
      const cancellationQueued = owned.some(work => work.message.type === 'resource.cancel');
      const neverPosted = owned.length > 0 && owned.every(work => ['resource.bytes', 'resource.bytesMany', 'resource.info'].includes(work.message.type)) &&
        !Array.from(active).some(work => work.owner === owner);
      // A duplicate cancellation retains the original queued control and its deadline.
      for (const work of owned) if (work.message.type !== 'resource.cancel') { remove(work); work.reject(unavailable()); }
      return neverPosted || cancellationQueued;
    },
    destroy(): void {
      stopped = true;
      for (const work of waiting.slice()) { remove(work); work.reject(unavailable()); }
    },
  };
}
