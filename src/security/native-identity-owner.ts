import { requireNativeModule } from 'expo';

interface IdentityOwnerModule { claimIdentityOwner(): boolean }

/** Trusted shell only. Never forward this admission method to a napplet. */
export function claimIdentityOwner(): boolean {
  const nativeOwner = requireNativeModule<IdentityOwnerModule>('HypergolicIdentityOwner');
  return nativeOwner.claimIdentityOwner() === true;
}
