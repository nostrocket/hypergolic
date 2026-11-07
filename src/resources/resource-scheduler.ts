import { ResourceError, RESOURCE_LIMITS } from './resource-contract.ts';

export const RESOURCE_WAIT_LIMITS = Object.freeze({ realm: 6, process: 16 });
type Release = () => void;
type Waiting = { signal: AbortSignal; check(): void; cancel(): void;
  resolve(release: Release): void; reject(error: unknown): void };
type Realm = { active: number; closed: boolean; waiting: Waiting[] };

/** FIFO within a realm; rotate realms after each admission without increasing active fetch limits. */
export function createResourceScheduler() {
  const ready: Realm[] = [];
  let active = 0, waiting = 0, pumping = false;
  function removeEmpty(realm: Realm): void {
    if (realm.waiting.length) return;
    const index = ready.indexOf(realm);
    if (index !== -1) ready.splice(index, 1);
  }
  function next(): Realm | undefined {
    for (let left = ready.length; left > 0; left--) {
      const realm = ready.shift()!;
      if (!realm.waiting.length) continue;
      ready.push(realm);
      if (!realm.closed && realm.active < RESOURCE_LIMITS.sessionConcurrent) return realm;
    }
    return undefined;
  }
  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (active < RESOURCE_LIMITS.processConcurrent) {
        const realm = next(); if (!realm) break;
        const job = realm.waiting.shift()!; waiting--; removeEmpty(realm);
        job.signal.removeEventListener('abort', job.cancel);
        try {
          job.check();
          if (realm.closed || job.signal.aborted) throw new ResourceError('timeout');
        } catch (error) { job.reject(error); continue; }
        realm.active++; active++;
        let released = false;
        job.resolve(() => {
          if (released) return;
          released = true; realm.active--; active--; pump();
        });
      }
    } finally { pumping = false; }
  }
  return Object.freeze({ bind() {
    const realm: Realm = { active: 0, closed: false, waiting: [] };
    return Object.freeze({
      acquire(signal: AbortSignal, check: () => void): Promise<Release> {
        return new Promise((resolve, reject) => {
          try {
            check();
            if (realm.closed || signal.aborted) throw new ResourceError('timeout');
            if (realm.waiting.length >= RESOURCE_WAIT_LIMITS.realm || waiting >= RESOURCE_WAIT_LIMITS.process) {
              throw new ResourceError('quota-exceeded');
            }
            const job: Waiting = {signal, check, resolve, reject, cancel() {
              const index = realm.waiting.indexOf(job);
              if (index === -1) return;
              realm.waiting.splice(index, 1); waiting--; removeEmpty(realm);
              signal.removeEventListener('abort', job.cancel);
              reject(new ResourceError('timeout')); pump();
            }};
            if (!realm.waiting.length) ready.push(realm);
            realm.waiting.push(job); waiting++;
            signal.addEventListener('abort', job.cancel, {once:true});
            if (signal.aborted) job.cancel(); else pump();
          } catch (error) { reject(error); }
        });
      },
      close(): void {
        realm.closed = true;
        while (realm.waiting.length) realm.waiting[0]!.cancel();
      },
    });
  }});
}
