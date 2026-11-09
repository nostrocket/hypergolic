import type { NostrEvent } from 'nostr-tools/pure';
import { isCapturedQueryEvent, RelayQueryError, RelayQueryDataError } from './relay-query-contract.ts';

export interface PublicVerificationModule {
  verifyPublicSignatures(operationId: string, tuples: string, timeoutMs: number): Promise<string>;
  cancelPublicSignatures(operationId: string): void;
}
export type QueryBatchVerifier = (events: readonly NostrEvent[], signal: AbortSignal,
  active: () => void, remainingMs: number) => Promise<void>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** App-only public math; no vault, key handles, signing or guest bridge. */
export function createNativeEventVerifier(module: PublicVerificationModule, newId: () => string): QueryBatchVerifier {
  return async (events, signal, active, remainingMs) => {
    active();
    if (signal.aborted || !Number.isSafeInteger(remainingMs) || remainingMs < 1 || remainingMs > 15_000 ||
      events.length < 1 || events.length > 200 || !events.every(isCapturedQueryEvent)) throw new RelayQueryError();
    const id = newId();
    if (!uuid.test(id)) throw new RelayQueryError();
    const tuples = JSON.stringify(events.map(event => [event.pubkey,event.id,event.sig]));
    if (tuples.length > 65_536) throw new RelayQueryError();
    let finished = false;
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_,reject) => {rejectCancelled = () => reject(new RelayQueryError());});
    const cancel = () => {
      try { module.cancelPublicSignatures(id); } catch { /* Native monotonic expiry remains authoritative. */ }
      rejectCancelled();
    };
    signal.addEventListener('abort',cancel,{once:true});
    try {
      active();
      if (signal.aborted) throw new RelayQueryError();
      const work = module.verifyPublicSignatures(id,tuples,remainingMs).finally(() => {finished = true;});
      const raw = await Promise.race([work,cancelled]);
      active();
      if (signal.aborted || typeof raw !== 'string' || raw.length > 2048) throw new RelayQueryError();
      // Exact private ABI also rejects duplicate keys, extra fields and ambiguous JSON coercions.
      const expected = JSON.stringify({operationId:id,results:Array(events.length).fill(true)});
      if (raw !== expected) throw new RelayQueryDataError();
    } finally {
      signal.removeEventListener('abort',cancel);
      if (!finished) try { module.cancelPublicSignatures(id); } catch { /* Release belongs to actual native unwind. */ }
    }
  };
}
