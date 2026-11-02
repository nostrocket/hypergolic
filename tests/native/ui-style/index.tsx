import { publicFixtureSigningMethods } from '../public-signing-methods';
import { registerRootComponent } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { IdentityShell } from '../../../src/shell/IdentityShell';
import { ShellAppearance } from '../../../src/shell/ShellAppearance';
import { ShellPressable } from '../../../src/shell/ShellPressable';
import { ApprovalSheet } from '../../../src/shell/ApprovalSheet';
import { useShellStyles, type ShellPalette, type ShellFonts } from '../../../src/shell/theme';
import { emptyWorkspace } from '../../../src/shell/workspace';
import { initialTestWorkspace, assertWorkspaceAvailability } from '../../../src/shell/fixtures';
import { formatNpub } from '../../../src/security/public-identity';
import { IdentityTransition } from '../../../src/security/identity-transition';
import { VaultError, type VaultSnapshot } from '../../../src/security/identity-vault';
import type { TrustedIdentityOwner } from '../../../src/security/trusted-identity-owner';
import { captureEventSnapshot } from '../../../src/security/event-snapshot';
import type { ApprovalItem } from '../../../src/security/approval-service';
import { openShellDatabase } from '../../../src/storage/database';
import { openNativeRelaySettings } from '../../../src/network/relay-settings-native';
import { createRuntimeOwner } from '../../../src/runtime/runtime-owner';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';

// Public point only. No key store, signer, private import, publication or upload exists here.
const publicKey = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const identity: VaultSnapshot = { vaultId: 'public_ui_style_fixture', revision: 1, selectedPubkey: publicKey,
  identities: [{ pubkey: publicKey, addedAt: 1, origin: 'generated', status: 'active' }], pendingDeletion: null };
const item: ApprovalItem = {
  id: 'ui-style-review',
  event: captureEventSnapshot({ kind: 1, content: 'A note from my own corner of the network.', created_at: 1791899242, tags: [] }, publicKey, ['wss://relay.example.com']),
  origin: { generation: 'presentation-only', sessionId: 'ui-style', instanceId: 'ui-style', epoch: 0,
    user: publicKey, publisher: publicKey, appId: 'feed-lab', version: 'e'.repeat(64) },
};
async function openFixture(): Promise<TrustedIdentityOwner> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const database = await openShellDatabase(SQLite, platform);
  const vault = {
    ...publicFixtureSigningMethods(() => identity),
    getSnapshot: () => identity,
    select: async (): Promise<VaultSnapshot> => { throw new VaultError('NOT_FOUND'); },
    prepareImport: async () => null, cancelImport: () => {}, commitImport: async (): Promise<VaultSnapshot> => { throw new VaultError('AUTHORIZATION_DENIED'); },
  };
  const transition = await IdentityTransition.open({ vault, database, seed: emptyWorkspace, assertAvailable: assertWorkspaceAvailability });
  const runtime = createRuntimeOwner(database, transition, loadNativeCapabilityPort());
  return { transition, runtime, formatNpub, relaySettings: await openNativeRelaySettings(SQLite, platform), resourceSettings: null };
}
// One process owner, matching the normal shell lifetime. The fixture has its own application ID.
const owner = openFixture();
function Fixture() {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  const [identityOwner, setOwner] = useState<TrustedIdentityOwner | null>(null);
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  useEffect(() => { let active = true; void owner.then(value => { if (active) setOwner(value); }).catch(() => { if (active) setError('UI fixture could not open'); }); return () => { active = false; }; }, []);
  const workspace = (populated: boolean) => identityOwner?.transition.getSnapshot().session.workspace.change(populated ? initialTestWorkspace() : emptyWorkspace());
  return <View style={styles.root}>
    {identityOwner ? <IdentityShell owner={identityOwner} /> : <Text style={styles.notice}>{error || 'Opening public UI fixture…'}</Text>}
    <View style={[styles.controls, { paddingBottom: Math.max(8, insets.bottom) }]}>
      <Text style={styles.notice}>UI fixture · public identity · no signing</Text>
      <View style={styles.row}>
        <ShellPressable testID="ui-fixture-empty" accessibilityRole="button" onPress={() => workspace(false)} style={styles.button}><Text style={styles.label}>Empty</Text></ShellPressable>
        <ShellPressable testID="ui-fixture-workspace" accessibilityRole="button" onPress={() => workspace(true)} style={styles.button}><Text style={styles.label}>Workspace</Text></ShellPressable>
        <ShellPressable testID="ui-fixture-review" accessibilityRole="button" onPress={() => setReview(true)} style={styles.button}><Text style={styles.label}>Review</Text></ShellPressable>
      </View>
    </View>
    <ApprovalSheet item={review ? item : null} nappletTitle="Feed Lab" busy={false} error={null} onApprove={() => setReview(false)} onReject={() => setReview(false)} onDismiss={() => setReview(false)} />
  </View>;
}
function App() { return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><ShellAppearance><Fixture /></ShellAppearance></SafeAreaProvider></GestureHandlerRootView>; }
const styles = StyleSheet.create({ root: { flex: 1 } });
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, controls: { paddingHorizontal: 16, paddingTop: 6, gap: 4, borderTopWidth: 1, borderColor: colors.border },
  notice: { color: colors.muted, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center' }, row: { flexDirection: 'row', gap: 12 },
  button: { flex: 1, alignItems: 'center', justifyContent: 'center' }, label: { color: colors.text, fontFamily: fonts.medium, fontSize: 13 },
});
registerRootComponent(App);
