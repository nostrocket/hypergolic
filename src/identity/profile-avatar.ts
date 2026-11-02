import type {IdentityTransition} from '../security/identity-transition.ts';
import {publicKey} from '../storage/codec.ts';
import type {TrustedIdentityDataPort} from './identity-service.ts';
import type {ProfileAvatarImage, ProfileAvatarReader} from './profile-avatar-image.ts';

export type ProfileAvatarSnapshot = Readonly<{user: string; epoch: number; avatar?: ProfileAvatarImage}>;
export interface ProfileAvatarStore {
  getSnapshot(): ProfileAvatarSnapshot | null;
  subscribe(listener: () => void): () => void;
  setIdentity(user: string, epoch: number, available: boolean): void;
  setForeground(foreground: boolean): void;
  dispose(): void;
}
type Selection = Readonly<{user: string; epoch: number; available: boolean}>;
const REQUEST_MS = 40_000;

/** A single process-owned image. No napplet origin, permission, key material or cache handle. */
export function createProfileAvatarStore(profiles: Pick<TrustedIdentityDataPort, 'readProfile'>, readImage: ProfileAvatarReader): ProfileAvatarStore {
  let selection: Selection | null = null;
  let snapshot: ProfileAvatarSnapshot | null = null;
  let foreground = false, disposed = false;
  let pending: AbortController | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: ProfileAvatarSnapshot | null) => {snapshot = value; for (const listener of listeners) listener();};
  const stop = () => {if (scheduled !== null) clearTimeout(scheduled); scheduled = null; pending?.abort(); pending = null;};
  const fallback = () => publish(selection ? Object.freeze({user: selection.user, epoch: selection.epoch}) : null);
  const load = async (captured: Selection) => {
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    const live = () => {
      if (disposed || !foreground || !captured.available || selection !== captured || pending !== controller || controller.signal.aborted) throw Error('avatar revoked');
    };
    try {
      live();
      const profile = await profiles.readProfile(captured.user, controller.signal, live);
      live();
      if (!profile?.picture) return;
      const avatar = await readImage(profile.picture, controller.signal, live);
      live();
      publish(Object.freeze({user: captured.user, epoch: captured.epoch, avatar}));
    } catch { /* Absence, denied network, invalid bytes and stale work keep the local fallback. */ }
    finally {clearTimeout(timer); if (pending === controller) pending = null;}
  };
  const start = () => {
    if (disposed || !foreground || !selection?.available) return;
    const captured = selection;
    // Let an aborted shared resolver release its admission slot before foreground return.
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!disposed && foreground && selection === captured) void load(captured);
    }, 0);
  };
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    setIdentity(user: string, epoch: number, available: boolean) {
      if (disposed) return;
      publicKey(user);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw Error('invalid avatar epoch');
      if (selection?.user === user && selection.epoch === epoch && selection.available === available) return;
      stop(); selection = Object.freeze({user, epoch, available}); fallback(); start();
    },
    setForeground(value: boolean) {
      if (disposed || foreground === value) return;
      foreground = value; stop(); fallback(); start();
    },
    dispose() {if (disposed) return; disposed = true; stop(); selection = null; publish(null); listeners.clear();},
  });
}

/** Subscribe before React: a transition immediately cancels the captured owner. */
export function bindProfileAvatarOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'subscribe'>, avatars: ProfileAvatarStore): () => void {
  const synchronize = () => {
    const state = identity.getSnapshot();
    avatars.setIdentity(state.session.vault.selectedPubkey, state.session.epoch, state.phase === 'ready');
  };
  synchronize();
  const unsubscribe = identity.subscribe(synchronize);
  return () => {unsubscribe(); avatars.dispose();};
}
