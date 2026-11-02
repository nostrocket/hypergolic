import type { IdentityTransition } from '../security/identity-transition.ts';
export interface NativeRoutingOwner { synchronizeRoutingOwner(user: string, epoch: number, available: boolean): void }
/** Called synchronously by IdentityTransition before secrets or workspace ownership change. */
export function bindRoutingOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'subscribe'>, native: NativeRoutingOwner): () => void {
  const synchronize = () => {
    const state = identity.getSnapshot();
    // A pending confirmation retains the current session until the user accepts.
    native.synchronizeRoutingOwner(state.session.vault.selectedPubkey, state.session.epoch, state.phase === 'ready' || state.phase === 'confirming');
  };
  synchronize(); return identity.subscribe(synchronize);
}
