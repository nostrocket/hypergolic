import type { VaultSnapshot } from './identity-vault.ts';

/** Only these inventory changes can preserve the current identity's workspace authority. */
export function isExpectedDeletion(before: VaultSnapshot, after: VaultSnapshot, target: string, completed: boolean): boolean {
  if (after.vaultId !== before.vaultId || after.selectedPubkey !== before.selectedPubkey
    || after.revision !== before.revision + (completed ? 1 : 0)) return false;
  if (completed ? after.pendingDeletion !== null
    : after.pendingDeletion !== before.pendingDeletion && !(before.pendingDeletion === null && after.pendingDeletion === target)) return false;
  const expected: VaultSnapshot['identities'][number][] = [];
  for (const identity of before.identities) {
    if (!completed || identity.pubkey !== target) expected.push({ ...identity, status: identity.pubkey === after.pendingDeletion ? 'deleting' : 'active' });
  }
  return JSON.stringify(after.identities) === JSON.stringify(expected);
}
