import { IdentityDeviceRequired } from './identity-device-required';
import { createOwnerBootstrap, IdentityRestartRequired } from './owner-bootstrap';
import { claimIdentityOwner } from './native-identity-owner';
import type { TrustedIdentityOwner } from './trusted-identity-owner';

type IdentityState = Readonly<
  | { status: 'opening' }
  | { status: 'ready'; owner: TrustedIdentityOwner }
  | { status: 'restart-required' | 'recovery-required' | 'device-required' | 'workspace-required' }
>;
const listeners = new Set<() => void>();
let state: IdentityState = Object.freeze({ status: 'opening' });
const startOwner = createOwnerBootstrap(claimIdentityOwner, async () => {
  const { initializeNativeRandom } = await import('./crypto-bootstrap');
  initializeNativeRandom();
  const { openTrustedIdentityOwner, WorkspaceStartupError } = await import('./trusted-identity-owner');
  try { return await openTrustedIdentityOwner(); } catch (error) {
    if (error instanceof WorkspaceStartupError) throw new WorkspaceEntryError();
    throw error;
  }
});
class WorkspaceEntryError extends Error {}
let observed = false;

function publish(next: IdentityState) {
  state = Object.freeze(next);
  for (const listener of listeners) listener();
}
export const getIdentityState = (): IdentityState => state;
export function subscribeIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function startIdentity(): void {
  if (observed) return;
  observed = true;
  void startOwner().then(owner => {
    publish({ status: 'ready', owner });
  }).catch(error => {
    if (error instanceof WorkspaceEntryError) publish({ status: 'workspace-required' });
    else if (error instanceof IdentityDeviceRequired) publish({ status: 'device-required' });
    else publish({ status: error instanceof IdentityRestartRequired ? 'restart-required' : 'recovery-required' });
  });
}
