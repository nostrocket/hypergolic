import { VaultError } from './identity-vault-model.ts';
import type { NativeSigningSource, NativeSigningHandoffState } from './native-vault-contract.ts';

export interface SigningHandoffReader {
  handoffState?(source: NativeSigningSource): NativeSigningHandoffState;
}
export function signingHandoffState(reader: SigningHandoffReader, source: NativeSigningSource | undefined): NativeSigningHandoffState {
  if (!source) return null;
  try {
    const state = reader.handoffState?.(source);
    return state === 'pending' || state === 'resumed' ? state : null;
  } catch { return null; }
}

/** Waits only for JS lifecycle delivery. Native grants and deadlines must be rechecked afterward. */
export class SigningForeground {
  private foreground = true;
  private readonly waiting = new Set<() => void>();
  get active(): boolean { return this.foreground; }
  setActive(value: boolean): void {
    this.foreground = value;
    if (value) for (const resume of this.waiting) resume();
  }
  wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new VaultError('SIGNER_UNCERTAIN'));
    if (this.foreground) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (accepted: boolean) => {
        clearTimeout(timer); this.waiting.delete(resume); signal.removeEventListener('abort', cancel);
        if (accepted && !signal.aborted) resolve(); else reject(new VaultError('SIGNER_UNCERTAIN'));
      };
      const resume = () => finish(true), cancel = () => finish(false);
      const timer = setTimeout(cancel, 5000);
      this.waiting.add(resume); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
}
