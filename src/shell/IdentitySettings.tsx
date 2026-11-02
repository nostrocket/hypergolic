import { backgroundIdentitySettings } from './identity-settings-lifecycle';
import { SignerSettings } from './SignerSettings';
import { identityChangeCopy } from './identity-change-copy';
import { NativeSignerCheck } from './NativeSignerCheck';
import { SettingsSection } from './SettingsSection';
import {FixturePublisherLab} from './FixturePublisherLab';
import {NotificationSettings} from './NotificationSettings';
import { RoutingSettings } from './RoutingSettings';
import {IdentityListSettings} from './IdentityListSettings';
import { UploadSettings } from './UploadSettings';
import { ResourceSettings } from './ResourceSettings';
import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View, type AppStateStatus } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { SettingsActions } from './Shell';
import type { IdentityChange, IdentitySession, IdentityTransition } from '../security/identity-transition';
import type { IdentitySettingsActions } from '../security/native-identity-actions';
import { VaultError } from '../security/identity-vault-model';
import { isSignerFailureCode, signerFailureMessage } from '../security/signing-methods';
import { useIdentityOwner } from './IdentityOwnerContext';
import { IdentityBackup } from './IdentityBackup';
import { RelaySettings } from './RelaySettings';
import { PublishedHostLab } from './PublishedHostLab';
import { OpenPublishedNapplet } from './OpenPublishedNapplet';
import { UpdatePublishedNapplet } from './UpdatePublishedNapplet';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

function Action({ title, testID, onPress, subdued = false }: { title: string; testID: string; onPress: () => void; subdued?: boolean }) {
  const { styles } = useShellStyles(createStyles);
  return <Pressable accessibilityRole="button" testID={testID} onPress={onPress} style={[styles.action, subdued && styles.subdued]}>
    <Text style={subdued ? styles.subduedText : styles.actionText}>{title}</Text>
  </Pressable>;
}
function ImportIdentity({ transition, onClose }: { transition: IdentityTransition; onClose: () => void }) {
  const { styles, colors } = useShellStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onAppStateChange = useEffectEvent((next: AppStateStatus) => {
    if (next !== 'active') { transition.cancelImportPreparation(); onClose(); }
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => { subscription.remove(); transition.cancelImportPreparation(); };
  }, [transition]);
  const review = () => {
    if (busy) return;
    setBusy(true); setError('');
    void transition.prepareImport().then(pending => { if (pending === null) onClose(); }).catch(failure => {
      setError(failure instanceof VaultError && failure.code === 'LIMIT_REACHED'
        ? 'The saved identity limit has been reached.' : 'Import was not completed. Your identity is unchanged.');
    }).finally(() => setBusy(false));
  };
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Import identity</Text>
    <Text style={styles.detail}>Enter your nsec in the next screen. Your current identity will remain saved on this device.</Text>
    {error !== '' && <Text testID="identity-import-error" accessibilityLiveRegion="polite" style={styles.detail}>{error}</Text>}
    {busy ? <ActivityIndicator color={colors.accent} /> : <Action title="Enter secret key" testID="identity-import-review" onPress={review} />}
    <Action title="Cancel" testID="identity-import-cancel" onPress={() => { transition.cancelImportPreparation(); onClose(); }} subdued />
  </View>;
}
function ConfirmIdentity({ pending, transition, npub }: { pending: IdentityChange; transition: IdentityTransition; npub: string }) {
  const { styles } = useShellStyles(createStyles);
  const copy = identityChangeCopy(pending, transition.getSnapshot().session.vault.selectedPubkey);
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
    <Text selectable testID="identity-change-npub" style={styles.npub}>{npub}</Text>
    <Text style={styles.detail}>{copy.detail}</Text>
    <Action title="Keep current settings" testID="identity-change-cancel" onPress={() => transition.cancel(pending)} subdued />
    <Action title={copy.approve} testID="identity-change-confirm"
      onPress={() => { void transition.confirm(pending).catch(() => undefined); }} />
  </View>;
}
type DeletionReview = Readonly<{ pubkey: string; session: IdentitySession }>;
function DeleteIdentity({ review, transition, actions, npub, busy, onClose }: {
  review: DeletionReview; transition: IdentityTransition; actions: IdentitySettingsActions;
  npub: string; busy: boolean; onClose: () => void;
}) {
  const { styles, colors } = useShellStyles(createStyles);
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void actions.isDeletionAvailable().then(value => { if (mounted) setAvailable(value); });
    return () => { mounted = false; };
  }, [actions]);
  const confirm = () => {
    if (available !== true || busy) return;
    void transition.deleteInactive(review.pubkey, review.session).catch(() => undefined).finally(() => {
      try { actions.endSettings(); } catch { /* Native authority also checks its lifetime. */ }
      onClose();
    });
  };
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>{busy ? 'Confirm on your device' : 'Delete saved identity?'}</Text>
    <Text selectable testID="identity-delete-npub" style={styles.npub}>{npub}</Text>
    <Text style={styles.detail}>This removes this account’s local key and saved signer connections from this device. Keep a separate backup of any local key you need to restore. Your currently selected identity and open napplets stay as they are.</Text>
    {busy ? <>
      <ActivityIndicator color={colors.accent} />
      <Action title="Cancel deletion" testID="identity-delete-cancel-auth" onPress={() => { transition.cancelDeletion(review.session); try { actions.cancelDeletion(); } catch { /* Revoked locally before native cleanup. */ } }} subdued />
    </> : <>
      <Action title="Keep identity" testID="identity-delete-cancel" onPress={onClose} subdued />
      {available === true ? <Action title="Authenticate and delete" testID="identity-delete-confirm" onPress={confirm} />
        : <Text testID="identity-delete-unavailable" style={styles.detail}>{available === null ? 'Checking device authentication…' : 'Device authentication is unavailable. Enable a device passcode or supported biometric authentication to delete an identity.'}</Text>}
    </>}
  </View>;
}
function failureMessage(failure: ReturnType<IdentityTransition['getSnapshot']>['failure']): string {
  if (isSignerFailureCode(failure)) return signerFailureMessage(failure);
  if (failure === 'LIMIT_REACHED') return 'The saved identity limit has been reached.';
  if (failure === 'DELETION_REJECTED') return 'Deletion was not approved. Your saved identities and open napplets are unchanged.';
  if (failure === 'DELETION_PENDING') return 'Deletion is paused. Authenticate again to finish removing the identity.';
  return 'The identity change was not accepted. Your current identity and open napplets are unchanged.';
}
function PublishedNappletSettings({ available, openPublished, publishedSessions, checkPublishedUpdate }: {
  available: boolean;
  openPublished: SettingsActions['openPublished'];
  publishedSessions: SettingsActions['publishedSessions'];
  checkPublishedUpdate: SettingsActions['checkPublishedUpdate'];
}) {
  const { styles } = useShellStyles(createStyles);
  if (!available) return null;
  return <>
    <OpenPublishedNapplet open={openPublished} />
    {publishedSessions.length > 0 && <>
      <Text accessibilityRole="header" style={styles.title}>Published napplet updates</Text>
      {publishedSessions.map(session => <UpdatePublishedNapplet key={session.id} session={session} check={checkPublishedUpdate} />)}
    </>}
  </>;
}
function SavedIdentities({session, transition, format, canDelete, onDelete}: {
  session: IdentitySession; transition: IdentityTransition; format(pubkey: string): string;
  canDelete: boolean; onDelete(pubkey: string): void;
}) {
  const { styles } = useShellStyles(createStyles);
  return <>
      <Text accessibilityRole="header" style={styles.title}>Saved identities</Text>
      {session.vault.identities.map(identity => <View key={identity.pubkey} style={styles.identity}><Pressable accessibilityRole="button"
        disabled={identity.pubkey === session.vault.selectedPubkey || identity.status !== 'active'}
        accessibilityState={{ selected: identity.pubkey === session.vault.selectedPubkey, disabled: identity.pubkey === session.vault.selectedPubkey || identity.status !== 'active' }}
        testID={`identity-select-${identity.pubkey}`} style={styles.identitySelect} onPress={() => transition.prepareSelect(identity.pubkey)}>
        <Text style={styles.npub}>{format(identity.pubkey)}</Text>
        <Text style={styles.detail}>{identity.pubkey === session.vault.selectedPubkey ? 'Selected' : identity.status === 'deleting' ? 'Deletion pending' : 'Use this identity'}</Text>
      </Pressable>
      {canDelete && identity.pubkey !== session.vault.selectedPubkey && (session.vault.pendingDeletion === null || session.vault.pendingDeletion === identity.pubkey) &&
        <Action title={identity.status === 'deleting' ? 'Finish deletion' : 'Delete identity'} testID={`identity-delete-${identity.pubkey}`}
          onPress={() => onDelete(identity.pubkey)} subdued />}
      </View>)}
  </>;
}
function SettingsHome({session, onBackup, onCloseBackup, onDelete, onImport, onSignedLab, openBundledTest, openStateLab, openPublished, publishedSessions, checkPublishedUpdate}: Omit<SettingsActions, 'closeSettings'> & {
  session: IdentitySession; onBackup(): void; onCloseBackup(): void; onDelete(pubkey: string): void; onImport(): void; onSignedLab(): void;
}) {
  const { styles } = useShellStyles(createStyles);
  const {transition, formatNpub, runtime, actions, relaySettings, resourceSettings, uploadSettings, listAccess, routing, notificationSettings, fixturePublisher} = useIdentityOwner();
  return <>
      <View style={styles.currentIdentity}><Text style={styles.identityLabel}>Your identity</Text>
        <Text selectable testID="settings-full-npub" style={styles.npub}>{formatNpub(session.vault.selectedPubkey)}</Text>
      </View>
      <PublishedNappletSettings available={Boolean(runtime)} openPublished={openPublished} publishedSessions={publishedSessions} checkPublishedUpdate={checkPublishedUpdate} />
      <View style={styles.sections}>
      <SettingsSection title="Identity" detail="Accounts, signing methods and backup" id="identity">
      <SignerSettings transition={transition} session={session} actions={actions} format={formatNpub}
        onBackup={onBackup} onCloseBackup={onCloseBackup} />
      <SavedIdentities session={session} transition={transition} format={formatNpub} canDelete={Boolean(actions)}
        onDelete={onDelete} />
      <Action title="Import identity" testID="settings-import-identity" onPress={onImport} />
      </SettingsSection>
      <SettingsSection title="Connections" detail="Relays, downloads and file uploads" id="connections">
      <RelaySettings service={relaySettings} />
      <ResourceSettings service={resourceSettings} />
      <UploadSettings service={uploadSettings ?? null} />
      </SettingsSection>
      <SettingsSection title="Napplet access" detail="Notifications, public lists and handlers" id="access">
      {routing && <RoutingSettings key={`routing-${session.epoch}`} service={routing.settings} />}
      {notificationSettings && <NotificationSettings key={`notifications-${session.epoch}`} service={notificationSettings} />}
      <IdentityListSettings service={listAccess ?? null} user={session.vault.selectedPubkey} />
      </SettingsSection>
      <SettingsSection title="Developer tools" detail="Test napplets and compatibility" id="developer">
      <NativeSignerCheck />
      {runtime && <Action title="Open NAP Support" testID="settings-open-nap-support" onPress={() => openStateLab('nap-support')} subdued />}
      {runtime && <>
        <Text accessibilityRole="header" style={styles.title}>Signed host test</Text>
        <Action title="Inspect signed test napplet" testID="settings-inspect-signed-test" onPress={onSignedLab} subdued />
      </>}
      {fixturePublisher && <FixturePublisherLab service={fixturePublisher} format={formatNpub} />}
      <Text accessibilityRole="header" style={styles.title}>Bundled test napplets</Text>
      <Action title="Open UX Lab" testID="settings-open-ux-lab" onPress={openBundledTest} subdued />
      {runtime && <>
        <Action title="Open Upload Lab" testID="settings-open-upload-lab" onPress={() => openStateLab('upload-lab')} subdued />
        <Action title="Open Resource Lab" testID="settings-open-resource-lab" onPress={() => openStateLab('resource-lab')} subdued />
        <Action title="Open Routing Lab" testID="settings-open-routing-lab" onPress={() => openStateLab('routing-lab')} subdued />
        <Action title="Open Routing Lab Peer" testID="settings-open-routing-lab-peer" onPress={() => openStateLab('routing-lab-peer')} subdued />
        <Action title="Open Feed Lab" testID="settings-open-feed-lab" onPress={() => openStateLab('feed-lab')} subdued />
        <Action title="Open Approval Lab" testID="settings-open-approval-lab" onPress={() => openStateLab('approval-lab')} subdued />
        <Action title="Open Close Lab" testID="settings-open-close-lab" onPress={() => openStateLab('close-lab')} subdued />
        <Action title="Open State Lab" testID="settings-open-state-lab" onPress={() => openStateLab('state-lab')} subdued />
        <Action title="Open State Lab Peer" testID="settings-open-state-lab-peer" onPress={() => openStateLab('state-lab-peer')} subdued />
        <Action title="Open State Lab · other publisher" testID="settings-open-state-lab-other-publisher" onPress={() => openStateLab('state-lab-other-publisher')} subdued />
      </>}      </SettingsSection>
      </View>
  </>;
}
export function IdentitySettings({ openBundledTest, openStateLab, openPublished, publishedSessions, checkPublishedUpdate }: SettingsActions) {
  const { styles, colors } = useShellStyles(createStyles);
  const { transition, formatNpub, actions } = useIdentityOwner();
  const state = useSyncExternalStore(transition.subscribe, transition.getSnapshot);
  const [importing, setImporting] = useState(false);
  const [deletion, setDeletion] = useState<DeletionReview | null>(null);
  const [backupReview, setBackupReview] = useState(false);
  const [signedLab, setSignedLab] = useState(false);
  const closeDeletion = useCallback(() => setDeletion(null), []);
  const closeImport = useCallback(() => setImporting(false), []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'background') return; // iOS system authentication may temporarily make the app inactive.
      backgroundIdentitySettings(transition, actions);
      closeDeletion();
      setBackupReview(false);
      setSignedLab(false);
    });
    return () => {
      subscription.remove();
      transition.cancelChange();
      transition.cancelDeletion(transition.getSnapshot().session);
      try { actions?.cancelBackup(); } catch { /* Local backup revocation runs before native cleanup. */ }
      try { actions?.endSettings(); } catch { /* Native lifetime independently revokes grants. */ }
    };
  }, [actions, closeDeletion, transition]);
  useEffect(() => () => {
    const pending = transition.getSnapshot().pending;
    if (pending) transition.cancel(pending);
  }, [transition]);
  if (deletion && actions) return <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.body}>
    <DeleteIdentity review={deletion} transition={transition} actions={actions} npub={formatNpub(deletion.pubkey)}
      busy={state.phase === 'deleting'} onClose={closeDeletion} />
  </ScrollView>;
  if (backupReview && actions) return <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.body}>
    <IdentityBackup actions={actions} session={state.session} npub={formatNpub(state.session.vault.selectedPubkey)} reviewing
      onReview={() => setBackupReview(true)} onClose={() => setBackupReview(false)} Action={Action} />
  </ScrollView>;
  if (signedLab) return <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    <PublishedHostLab onClose={() => setSignedLab(false)} sessionAuthority={() => transition.sessionAuthority()} />
  </ScrollView>;
  if (state.phase === 'deleting') return <View style={styles.body}>
    <ActivityIndicator color={colors.accent} /><Text style={styles.title}>Finishing identity action…</Text>
  </View>;
  if (state.phase === 'switching') return <View style={styles.body}>
    <ActivityIndicator color={colors.accent} /><Text accessibilityRole="header" style={styles.title}>Updating account…</Text>
  </View>;
  if (state.pending) return <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    <ConfirmIdentity pending={state.pending} transition={transition} npub={formatNpub(state.pending.pubkey)} />
  </ScrollView>;
  return <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    {state.failure && <Text testID="identity-change-error" accessibilityLiveRegion="polite" style={styles.detail}>{failureMessage(state.failure)}</Text>}
    {importing ? <ImportIdentity transition={transition} onClose={closeImport} /> : <>
      <SettingsHome session={state.session} onBackup={() => setBackupReview(true)} onCloseBackup={() => setBackupReview(false)}
        onDelete={pubkey => setDeletion(Object.freeze({pubkey, session: state.session}))} onImport={() => setImporting(true)} onSignedLab={() => setSignedLab(true)}
        openBundledTest={openBundledTest} openStateLab={openStateLab} openPublished={openPublished} publishedSessions={publishedSessions} checkPublishedUpdate={checkPublishedUpdate} />
    </>}

  </ScrollView>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  body: { padding: 24, paddingTop: 12, paddingBottom: 40, gap: 28 },
  currentIdentity: { borderLeftWidth: 2, borderColor: colors.accent, paddingLeft: 14, gap: 8 },
  identityLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.5, color: colors.muted, textTransform: 'uppercase' },
  sections: { gap: 0 },
  group: { gap: 20 },
  title: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
  npub: { fontFamily: fonts.mono, color: colors.text, fontSize: 12, lineHeight: 20, },
  input: { fontFamily: fonts.body, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 0, minHeight: 56, padding: 16, fontSize: 16 },
  identity: { padding: 16, gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 0 },
  identitySelect: { minHeight: 56, gap: 10 },
  action: { padding: 18, minHeight: 56, borderRadius: 0, backgroundColor: colors.primary, alignItems: 'center' },
  subdued: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  subduedText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
});
