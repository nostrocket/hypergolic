import { createContext, useContext } from 'react';
import type { TrustedIdentityOwner } from '../security/trusted-identity-owner';

export const OwnerContext = createContext<TrustedIdentityOwner | null>(null);
export function useIdentityOwner(): TrustedIdentityOwner {
  const owner = useContext(OwnerContext);
  if (owner === null) throw new Error('Identity settings require the trusted owner');
  return owner;
}
