import { publicFixtureSigningMethods } from '../public-signing-methods';
import { registerRootComponent } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import defaults from '../../../src/config/default-relays.json';
import { loadNativePublishedTransferPort } from '../../../src/napplets/native-transfer-port';
import { loadNativeApprovalPort } from '../../../src/runtime/native-approval-port';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { createRuntimeOwner, type RuntimeOwner } from '../../../src/runtime/runtime-owner';
import { ApprovalService } from '../../../src/security/approval-service';
import { createApprovalOwner } from '../../../src/security/approval-owner';
import { formatNpub } from '../../../src/security/public-identity';
import { IdentityTransition } from '../../../src/security/identity-transition';
import { VaultError, type VaultSnapshot } from '../../../src/security/identity-vault';
import type { TrustedIdentityOwner } from '../../../src/security/trusted-identity-owner';
import { assertWorkspaceAvailability } from '../../../src/shell/fixtures';
import { IdentityShell } from '../../../src/shell/IdentityShell';
import { emptyWorkspace } from '../../../src/shell/workspace';
import { colors } from '../../../src/shell/theme';
import { openShellDatabase } from '../../../src/storage/database';
import { CHANGED_ACCESS_NADDR, ORIGINAL_PUBLISHED_UPDATE_ADDRESS, createPublishedUpdateFixtureSource } from './source';

// Public fixture identity only. This entry cannot import, store, reveal, or sign with an nsec.
// Generated once from a random disposable secret that was not stored or printed.
const PUBLIC_IDENTITY = '0349e311d2f7f8e2750e169025728a5bd5ac804c285882928bf098cf8b1e98be';
const source = createPublishedUpdateFixtureSource(defaults.lookupRelays);
const identity: VaultSnapshot = Object.freeze({ vaultId: 'public_published_update_fixture', revision: 1,
  selectedPubkey: PUBLIC_IDENTITY, identities: Object.freeze([Object.freeze({ pubkey: PUBLIC_IDENTITY,
    addedAt: 1, origin: 'generated' as const, status: 'active' as const })]), pendingDeletion: null });

async function openPublicFixture(): Promise<TrustedIdentityOwner> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw new Error('PUBLIC_FIXTURE_UNAVAILABLE');
  const database = await openShellDatabase(SQLite, Platform.OS);
  const vault = Object.freeze({ ...publicFixtureSigningMethods(() => identity), getSnapshot: () => identity,
    select: async (_pubkey: string): Promise<VaultSnapshot> => { throw new VaultError('NOT_FOUND'); },
    prepareImport: async () => null, cancelImport: () => {}, commitImport: async (): Promise<VaultSnapshot> => { throw new VaultError('AUTHORIZATION_DENIED'); },
  });
  const transition = await IdentityTransition.open({ vault, database,
    seed: emptyWorkspace, assertAvailable: assertWorkspaceAvailability });
  let runtime: RuntimeOwner | null = null;
  const approvals = new ApprovalService(loadNativeApprovalPort(), createApprovalOwner(transition, origin => {
    if (!runtime) throw new Error('PUBLIC_FIXTURE_SIGNING_UNAVAILABLE');
    runtime.assertPublishedApproval(origin);
  }), {
    sign: async () => { throw new Error('PUBLIC_FIXTURE_SIGNING_UNAVAILABLE'); },
    publishEvent: async () => { throw new Error('PUBLIC_FIXTURE_PUBLICATION_UNAVAILABLE'); },
  });
  runtime = createRuntimeOwner(database, transition, loadNativeCapabilityPort(),
    { service: approvals, destinations: () => Object.freeze([...defaults.networkRelays]) },
    { sqlite: SQLite, source, native: loadNativePublishedTransferPort(),
      lookupRelays: () => Object.freeze([...defaults.lookupRelays]) });
  return Object.freeze({ transition, formatNpub, approvals, runtime, relaySettings: null, resourceSettings: null });
}

let state: Readonly<{ owner: TrustedIdentityOwner | null; error: boolean }> = Object.freeze({ owner: null, error: false });
let started = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function snapshot() { return state; }
function start() {
  if (started) return;
  started = true;
  void openPublicFixture().then(owner => {
    state = Object.freeze({ owner, error: false });
    for (const listener of listeners) listener();
  }).catch(() => {
    state = Object.freeze({ owner: null, error: true });
    for (const listener of listeners) listener();
  });
}

function PublishedUpdateFixture() {
  const current = useSyncExternalStore(subscribe, snapshot);
  const [released, setReleased] = useState(false);
  const [changedAccessReleased, setChangedAccessReleased] = useState(false);
  useEffect(start, []);
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}>
    <SafeAreaView edges={['top']} style={styles.notice}>
      <Text testID="update-fixture-label" style={styles.label}>Published update QA · public identity · signing unavailable</Text>
      <Text selectable testID="update-fixture-address" style={styles.address}>{ORIGINAL_PUBLISHED_UPDATE_ADDRESS}</Text>
      <Pressable accessibilityRole="button" testID="update-fixture-release" disabled={released}
        accessibilityState={{ disabled: released }} onPress={() => { source.releaseUpdate(); setReleased(true); }} style={styles.release}>
        <Text style={styles.releaseText}>{released ? 'New revision available' : 'Make new revision available'}</Text>
      </Pressable>
      <Text testID="changed-access-fixture-label" style={styles.label}>Changed access QA · theme to theme + relay</Text>
      <Text selectable testID="changed-access-fixture-address" style={styles.address}>{CHANGED_ACCESS_NADDR}</Text>
      <Pressable accessibilityRole="button" testID="changed-access-fixture-release" disabled={changedAccessReleased}
        accessibilityState={{ disabled: changedAccessReleased }}
        onPress={() => { source.releaseChangedAccess(); setChangedAccessReleased(true); }} style={styles.release}>
        <Text style={styles.releaseText}>{changedAccessReleased ? 'Changed-access revision available' : 'Release changed-access revision'}</Text>
      </Pressable>
    </SafeAreaView>
    {current.owner ? <IdentityShell owner={current.owner} />
      : <Text style={styles.label}>{current.error ? 'Published update fixture unavailable' : 'Opening public update fixture…'}</Text>}
  </View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  notice: { backgroundColor: colors.surface, paddingHorizontal: 12, paddingBottom: 6, gap: 4 },
  label: { color: colors.text, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  address: { color: colors.muted, fontSize: 10, lineHeight: 14 },
  release: { alignSelf: 'center', minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12,
    borderWidth: 1, borderColor: colors.border },
  releaseText: { color: colors.text, fontSize: 13 },
});
registerRootComponent(PublishedUpdateFixture);
