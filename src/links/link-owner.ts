import type {IdentityTransition} from '../security/identity-transition.ts';

export interface NativeLinkOwner {synchronizeLinkOwner(user: string, epoch: number, available: boolean): void}
/** Synchronize native denial authority before the transition continues or React dismantles views. */
export function bindLinkOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'subscribe'>, native: NativeLinkOwner): () => void {
  const synchronize = () => {
    const state = identity.getSnapshot();
    native.synchronizeLinkOwner(state.session.vault.selectedPubkey, state.session.epoch, state.phase === 'ready');
  };
  synchronize();
  return identity.subscribe(synchronize);
}
