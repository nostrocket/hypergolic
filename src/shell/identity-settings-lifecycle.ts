import type { IdentitySettingsActions } from '../security/native-identity-actions.ts';
import type { IdentityTransition } from '../security/identity-transition.ts';

/** Background closes Settings reviews while native code owns exact signer handoff retention. */
export function backgroundIdentitySettings(transition: IdentityTransition, actions?: IdentitySettingsActions): void {
  const state = transition.getSnapshot();
  if (state.pending) transition.cancel(state.pending);
  transition.cancelChange();
  transition.cancelDeletion(state.session);
  transition.backgroundRemotePreparation();
  if (state.phase === 'deleting') {
    try { actions?.cancelDeletion(); } catch { /* The transition has already revoked deletion. */ }
  }
  try { actions?.backgroundSettings(); } catch { /* Native lifecycle independently revokes backup access. */ }
}
