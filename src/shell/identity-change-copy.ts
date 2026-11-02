import type { IdentityChange } from '../security/identity-transition.ts';
import { signingMethodAction } from '../security/signing-methods.ts';

export function identityChangeCopy(change: IdentityChange, selectedPubkey: string) {
  const restart = 'Your identity and saved data stay the same. Open napplets will restart and pending requests will be cancelled.';
  switch (change.kind) {
    case 'select-method': return { title: 'Switch signing method?', detail: restart, approve: signingMethodAction(change.method) };
    case 'disconnect-method': return { title: change.method === 'nip55' ? 'Disconnect signer app?' : 'Disconnect remote signer?',
      detail: 'This removes the connection from this device. If it is selected, signing stays unavailable until you choose a method. Your identity and saved data stay here.', approve: 'Disconnect signer' };
    case 'delete-local-key': return { title: 'Remove local key?',
      detail: 'This removes this account’s secret key from this device. Keep a separate backup to restore it. Your identity, remote connections and saved data stay here. If local signing is selected, you will need to choose another method.', approve: 'Authenticate and remove key' };
    case 'refresh-remote': return { title: 'Update signer relays?', detail: restart, approve: 'Review relay changes' };
    case 'connect': return { title: 'Connect and use remote signer?',
      detail: change.pubkey === selectedPubkey ? restart : 'Open napplets will restart with this identity’s saved data. Your current identity remains saved. Pending signing requests will be cancelled.', approve: 'Connect and use signer' };
    case 'connect-android': return { title: 'Connect and use Android signer app?',
      detail: change.pubkey === selectedPubkey ? restart : 'Open napplets will restart with this identity’s saved data. Your current identity remains saved. Pending signing requests will be cancelled.', approve: 'Connect and use signer app' };
    case 'import':
      if (change.pubkey === selectedPubkey) return { title: 'Use local key for this identity?', detail: restart, approve: 'Use local key' };
      return { title: 'Switch identity?', detail: 'Every open napplet will restart with this identity’s saved data. Unsaved work will be lost and pending signing requests will be cancelled.', approve: 'Import and switch' };
    case 'select': return { title: 'Switch identity?', detail: 'Every open napplet will restart with this identity’s saved data. Unsaved work will be lost and pending signing requests will be cancelled.', approve: 'Switch identity' };
  }
}
