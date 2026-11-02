import {Configuration} from './Configuration';
import {Notifications} from './Notifications';
import {RoutingReview} from './RoutingReview';
import {IdentityListReview} from './IdentityListReview';
import { useEffect, useSyncExternalStore } from 'react';
import { OwnerContext } from './IdentityOwnerContext';
import { AppState, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { TrustedIdentityOwner } from '../security/trusted-identity-owner';
import { IdentitySettings } from './IdentitySettings';
import { WorkspaceEntry } from './WorkspaceEntry';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { RuntimeContext } from '../runtime/RuntimeContext';

const noAvatar = () => null;
// Fixture owners without an avatar store provide an inert subscription.
const noAvatarSubscription = () => () => undefined;
export function IdentityShell({ owner }: { owner: TrustedIdentityOwner }) {
  const { styles } = useShellStyles(createStyles);
  const { transition, formatNpub } = owner;
  const state = useSyncExternalStore(transition.subscribe, transition.getSnapshot);
  const avatar = useSyncExternalStore(owner.profileAvatar?.subscribe ?? noAvatarSubscription, owner.profileAvatar?.getSnapshot ?? noAvatar);
  useEffect(() => {
    owner.profileAvatar?.setForeground(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', next => {
      owner.profileAvatar?.setForeground(next === 'active');
      const pending = transition.getSnapshot().pending;
      if (next !== 'active' && pending) transition.cancel(pending);
    });
    return () => {subscription.remove(); owner.profileAvatar?.setForeground(false);};
  }, [transition, owner.profileAvatar]);
  useEffect(() => () => owner.runtime?.revokeAllPublished(), [owner.runtime, state.session.epoch]);
  const selectedAvatar = state.phase === 'ready' && avatar?.user === state.session.vault.selectedPubkey && avatar.epoch === state.session.epoch ? avatar.avatar : undefined;
  if (state.phase === 'recovery') return <SafeAreaView style={styles.problem}>
    <Text accessibilityRole="header" style={styles.heading}>Your identity needs attention</Text>
    <Text style={styles.detail}>The identity change could not be confirmed. Restart Hypergolic to reopen your saved identity and workspace.</Text>
  </SafeAreaView>;
  return <OwnerContext value={owner}><RuntimeContext value={owner.runtime ?? null}>
    <WorkspaceEntry key={state.session.epoch} identity={{ npub: formatNpub(state.session.vault.selectedPubkey), avatar: selectedAvatar, avatarKey: selectedAvatar?.cacheKey }}
      controller={state.session.workspace} approvals={owner.approvals} uploads={owner.uploads} epoch={state.session.epoch} blocked={state.phase === 'switching' || state.phase === 'deleting'} settingsComponent={IdentitySettings}
      footer={owner.notify && <Notifications service={owner.notify} blocked={state.phase !== 'ready'} />} />
    {owner.config && <Configuration service={owner.config} blocked={state.phase !== 'ready'} />}
    <RoutingReview service={owner.routing?.reviews ?? null} blocked={state.phase !== 'ready'} />
    <IdentityListReview service={owner.listAccess ?? null} blocked={state.phase !== 'ready'} />
  </RuntimeContext></OwnerContext>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  problem: { flex: 1, justifyContent: 'center', padding: 32, gap: 18, backgroundColor: colors.background },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
});
