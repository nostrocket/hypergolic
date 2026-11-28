import { developerToolsEnabled } from '../config/build-info';
import { AboutSettings } from './AboutSettings';
import { backgroundIdentitySettings } from './identity-settings-lifecycle';
import { DevicePrivacySettings, useDevicePrivacyPreferences } from './DevicePrivacySettings';
import { SignerSettings } from './SignerSettings';
import { identityChangeCopy } from './identity-change-copy';
import { NativeSignerCheck } from './NativeSignerCheck';
import { SettingsSection } from './SettingsSection';
import { SettingsIndex, ConnectionsIndex } from './SettingsIndex';
import { SettingsRoomHeader } from './SettingsRoom';
import { parentRoom, roomTitles, type SettingsRoom } from './settings-directory';
import {FixturePublisherLab} from './FixturePublisherLab';
import {NotificationSettings} from './NotificationSettings';
import { RoutingSettings } from './RoutingSettings';
import {IdentityListSettings} from './IdentityListSettings';
import { UploadSettings } from './UploadSettings';
import { ResourceSettings } from './ResourceSettings';
import { useCallback, useEffect, useEffectEvent, useImperativeHandle, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TextInput, View, type AppStateStatus } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { SettingsActions } from './Shell';
import type { IdentityChange, IdentitySession, IdentityTransition } from '../security/identity-transition';
import type { IdentitySettingsActions } from '../security/native-identity-actions';
import { parsePublicIdentity } from '../security/public-identity';
import { VaultError } from '../security/identity-vault-model';
import { isSignerFailureCode, signerFailureMessage } from '../security/signing-methods';
import { useIdentityOwner } from './IdentityOwnerContext';
import { IdentityBackup } from './IdentityBackup';
import { RelaySettings } from './RelaySettings';
import { PublishedHostLab } from './PublishedHostLab';
import { SettingsForm } from './SettingsForm';
import { OpenPublishedNapplet } from './OpenPublishedNapplet';
import { UpdatePublishedNapplet } from './UpdatePublishedNapplet';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

function Action({ title, testID, onPress }: { title: string; testID: string; onPress: () => void }) {
  const { styles } = useShellStyles(createStyles);
  return <Pressable accessibilityRole="button" testID={testID} onPress={onPress} style={styles.action}>
    <Text style={styles.actionText}>{title}</Text>
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
  return <SettingsForm action={busy ? undefined : {label: "Enter secret key", testID: "identity-import-review", onPress: review}}>
    <Text accessibilityRole="header" style={styles.title}>Import identity</Text>
    <Text style={styles.detail}>Enter your nsec in the next screen. Your current identity will remain saved on this device.</Text>
    {error !== '' && <Text testID="identity-import-error" accessibilityLiveRegion="polite" style={styles.detail}>{error}</Text>}
    {busy && <ActivityIndicator color={colors.accent} />}
    <Action title="Cancel" testID="identity-import-cancel" onPress={() => { transition.cancelImportPreparation(); onClose(); }} />
  </SettingsForm>;
}
function PublicIdentity({ transition, onClose }: { transition: IdentityTransition; onClose(): void }) {
  const { styles } = useShellStyles(createStyles);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const review = () => {
    let pubkey: string;
    try { pubkey = parsePublicIdentity(input); }
    catch { setError('Enter a valid npub or 64-character public key.'); return; }
    if (transition.getSnapshot().session.vault.identities.some(identity => identity.pubkey === pubkey)) {
      setError('This identity is already saved. Choose it from Saved identities.'); return;
    }
    try { transition.preparePublicIdentity(pubkey); onClose(); }
    catch { setError('This public profile could not be opened. Try again.'); }
  };
  return <SettingsForm action={{label: "Review public profile", testID: "identity-public-review", onPress: review}}>
    <Text accessibilityRole="header" style={styles.title}>Read-only public profile</Text>
    <Text style={styles.detail}>Enter an npub or public key to read public data as that account. This adds no private key or signing method. Signing and publishing are unavailable.</Text>
    <TextInput accessibilityLabel="Public key or npub" testID="identity-public-key" style={styles.input}
      value={input} onChangeText={setInput} returnKeyType="go" onSubmitEditing={review} autoCapitalize="none" autoCorrect={false} maxLength={128}
      placeholder="npub or public key" />
    {error !== '' && <Text testID="identity-public-error" accessibilityLiveRegion="polite" style={styles.detail}>{error}</Text>}
    <Action title="Cancel" testID="identity-public-cancel" onPress={onClose} />
  </SettingsForm>;
}
function ConfirmIdentity({ pending, transition, npub }: { pending: IdentityChange; transition: IdentityTransition; npub: string }) {
  const { styles } = useShellStyles(createStyles);
  const copy = identityChangeCopy(pending, transition.getSnapshot().session.vault.selectedPubkey);
  return <SettingsForm action={{label: copy.approve, testID: "identity-change-confirm", onPress: () => { void transition.confirm(pending).catch(() => undefined); }}}>
    <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
    <Text selectable testID="identity-change-npub" style={styles.npub}>{npub}</Text>
    <Text style={styles.detail}>{copy.detail}</Text>
    <Action title="Keep current settings" testID="identity-change-cancel" onPress={() => transition.cancel(pending)} />
  </SettingsForm>;
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
  return <SettingsForm action={available === true && !busy ? {label: "Authenticate and delete", testID: "identity-delete-confirm", onPress: confirm} : undefined}>
    <Text accessibilityRole="header" style={styles.title}>{busy ? 'Confirm on your device' : 'Delete saved identity?'}</Text>
    <Text selectable testID="identity-delete-npub" style={styles.npub}>{npub}</Text>
    <Text style={styles.detail}>This removes this account’s local key and saved signer connections from this device. Keep a separate backup of any local key you need to restore. Your currently selected identity and open napplets stay as they are.</Text>
    {busy ? <>
      <ActivityIndicator color={colors.accent} />
      <Action title="Cancel deletion" testID="identity-delete-cancel-auth" onPress={() => { transition.cancelDeletion(review.session); try { actions.cancelDeletion(); } catch { /* Revoked locally before native cleanup. */ } }} />
    </> : <>
      <Action title="Keep identity" testID="identity-delete-cancel" onPress={onClose} />
      {available !== true && <Text testID="identity-delete-unavailable" style={styles.detail}>{available === null ? 'Checking device authentication…' : 'Device authentication is unavailable. Enable a device passcode or supported biometric authentication to delete an identity.'}</Text>}
    </>}
  </SettingsForm>;
}
function failureMessage(failure: ReturnType<IdentityTransition['getSnapshot']>['failure']): string {
  if (isSignerFailureCode(failure)) return signerFailureMessage(failure);
  if (failure === 'LIMIT_REACHED') return 'The saved identity limit has been reached.';
  if (failure === 'DELETION_REJECTED') return 'Deletion was not approved. Your saved identities and open napplets are unchanged.';
  if (failure === 'DELETION_PENDING') return 'Deletion is paused. Authenticate again to finish removing the identity.';
  return 'The identity change was not accepted. Your current identity and open napplets are unchanged.';
}
function SavedIdentities({session, transition, format, canDelete, onDelete}: {
  session: IdentitySession; transition: IdentityTransition; format(pubkey: string): string;
  canDelete: boolean; onDelete(pubkey: string): void;
}) {
  const { styles } = useShellStyles(createStyles);
  const [selectionError, setSelectionError] = useState('');
  const select = (pubkey: string) => {
    try {
      transition.prepareSelect(pubkey);
      setSelectionError('');
    } catch {
      setSelectionError('The account could not be selected. Finish any pending signing request and try again.');
    }
  };
  return <>
      <Text accessibilityRole="header" style={styles.title}>Saved identities</Text>
      {selectionError && <Text accessibilityLiveRegion="polite" style={styles.detail}>{selectionError}</Text>}
      {session.vault.identities.map(identity => <View key={identity.pubkey} style={styles.identity}><Pressable accessibilityRole="button"
        disabled={identity.pubkey === session.vault.selectedPubkey || identity.status !== 'active'}
        accessibilityState={{ selected: identity.pubkey === session.vault.selectedPubkey, disabled: identity.pubkey === session.vault.selectedPubkey || identity.status !== 'active' }}
        testID={`identity-select-${identity.pubkey}`} style={styles.identitySelect} onPress={() => select(identity.pubkey)}>
        <Text style={styles.npub}>{format(identity.pubkey)}</Text>
        <Text style={styles.detail}>{identity.pubkey === session.vault.selectedPubkey ? 'Selected' : identity.status === 'deleting' ? 'Deletion pending' : 'Use this identity'}</Text>
      </Pressable>
      {canDelete && identity.pubkey !== session.vault.selectedPubkey && (session.vault.pendingDeletion === null || session.vault.pendingDeletion === identity.pubkey) &&
        <Action title={identity.status === 'deleting' ? 'Finish deletion' : 'Delete identity'} testID={`identity-delete-${identity.pubkey}`}
          onPress={() => onDelete(identity.pubkey)} />}
      </View>)}
  </>;
}
function DeveloperSettings({ onSignedLab, openBundledTest, openStateLab }: Pick<SettingsActions, 'openBundledTest' | 'openStateLab'> & { onSignedLab(): void }) {
  const { styles } = useShellStyles(createStyles);
  const { runtime, fixturePublisher, formatNpub } = useIdentityOwner();
  if (!developerToolsEnabled) return null;
  return <>
      <NativeSignerCheck />
      {runtime && <Action title="Open NAP Support" testID="settings-open-nap-support" onPress={() => openStateLab('nap-support')} />}
      {runtime && <>
        <Text accessibilityRole="header" style={styles.title}>Signed host test</Text>
        <Action title="Inspect signed test napplet" testID="settings-inspect-signed-test" onPress={onSignedLab} />
      </>}
      {fixturePublisher && <FixturePublisherLab service={fixturePublisher} format={formatNpub} />}
      <Text accessibilityRole="header" style={styles.title}>Bundled test napplets</Text>
      <Action title="Open UX Lab" testID="settings-open-ux-lab" onPress={openBundledTest} />
      {runtime && <>
        <Action title="Open Upload Lab" testID="settings-open-upload-lab" onPress={() => openStateLab('upload-lab')} />
        <Action title="Open Resource Lab" testID="settings-open-resource-lab" onPress={() => openStateLab('resource-lab')} />
        <Action title="Open Routing Lab" testID="settings-open-routing-lab" onPress={() => openStateLab('routing-lab')} />
        <Action title="Open Routing Lab Peer" testID="settings-open-routing-lab-peer" onPress={() => openStateLab('routing-lab-peer')} />
        <Action title="Open Feed Lab" testID="settings-open-feed-lab" onPress={() => openStateLab('feed-lab')} />
        <Action title="Open Approval Lab" testID="settings-open-approval-lab" onPress={() => openStateLab('approval-lab')} />
        <Action title="Open Close Lab" testID="settings-open-close-lab" onPress={() => openStateLab('close-lab')} />
        <Action title="Open State Lab" testID="settings-open-state-lab" onPress={() => openStateLab('state-lab')} />
        <Action title="Open State Lab Peer" testID="settings-open-state-lab-peer" onPress={() => openStateLab('state-lab-peer')} />
        <Action title="Open State Lab · other publisher" testID="settings-open-state-lab-other-publisher" onPress={() => openStateLab('state-lab-other-publisher')} />
      </>}
    </>;
}
function IdentityRoom({session, onBackup, onCloseBackup, onDelete, onPublic, onImport}: {
  session: IdentitySession; onBackup(): void; onCloseBackup(): void; onDelete(pubkey: string): void; onPublic(): void; onImport(): void;
}) {
  const {transition, formatNpub, actions} = useIdentityOwner();
  return <>
    <SignerSettings transition={transition} session={session} actions={actions} format={formatNpub}
      onBackup={onBackup} onCloseBackup={onCloseBackup} />
    <SavedIdentities session={session} transition={transition} format={formatNpub} canDelete={Boolean(actions)} onDelete={onDelete} />
    <Action title="Read-only public profile" testID="settings-public-identity" onPress={onPublic} />
    <Action title="Import identity" testID="settings-import-identity" onPress={onImport} />
  </>;
}

function NappletAccessRoom({session, publishedSessions, checkPublishedUpdate}: Pick<SettingsActions, 'publishedSessions' | 'checkPublishedUpdate'> & {session: IdentitySession}) {
  const {routing, notificationSettings, listAccess, runtime} = useIdentityOwner();
  const publishedCount = publishedSessions.length;
  return <>
    {routing && <RoutingSettings key={`routing-${session.epoch}`} service={routing.settings} />}
    {notificationSettings && <NotificationSettings key={`notifications-${session.epoch}`} service={notificationSettings} />}
    <IdentityListSettings service={listAccess ?? null} user={session.vault.selectedPubkey} />
    {runtime && publishedCount > 0 && <SettingsSection title="Published napplet updates"
      detail={`${publishedCount} ${publishedCount === 1 ? 'napplet' : 'napplets'} in this workspace`} id="published-updates">
      {publishedSessions.map(napplet => <UpdatePublishedNapplet key={napplet.id} session={napplet} check={checkPublishedUpdate} />)}
    </SettingsSection>}
  </>;
}

function SettingsRooms({settings, room, open, onBack, identity, onSignedLab, failure}: {
  settings: SettingsActions; room: SettingsRoom | 'index'; open(room: SettingsRoom): void; onBack(): void;
  identity: ComponentProps<typeof IdentityRoom>; onSignedLab(): void; failure: ReactNode;
}) {
  const {styles} = useShellStyles(createStyles);
  const {formatNpub, runtime, relaySettings, resourceSettings, uploadSettings} = useIdentityOwner();
  const privacy = useDevicePrivacyPreferences(identity.session.vault.selectedPubkey);
  if (room === 'open-napplet') return <OpenPublishedNapplet open={settings.openPublished} onBack={onBack} />;
  if (room === 'relays') return <RelaySettings service={relaySettings} onBack={onBack} />;
  if (room === 'downloads') return <ResourceSettings service={resourceSettings} onBack={onBack} />;
  if (room === 'uploads') return <UploadSettings service={uploadSettings ?? null} onBack={onBack} />;
  return <>
    {room === 'index' ? settings.indexHeader : <SettingsRoomHeader title={roomTitles[room]} onBack={onBack} />}
    <ScrollView key={room} contentContainerStyle={room === 'index' ? styles.index : styles.body} keyboardShouldPersistTaps="handled">
      {failure}
      {room === 'index' && <SettingsIndex npub={formatNpub(identity.session.vault.selectedPubkey)} identities={identity.session.vault.identities.length}
        published={Boolean(runtime)} lock={privacy.preferences?.workspace} open={open} />}
      {room === 'identity' && <IdentityRoom {...identity} />}
      {room === 'device-privacy' && <DevicePrivacySettings privacy={privacy} />}
      {room === 'connections' && <ConnectionsIndex open={open} />}
      {room === 'access' && <NappletAccessRoom session={identity.session} publishedSessions={settings.publishedSessions} checkPublishedUpdate={settings.checkPublishedUpdate} />}
      {room === 'developer' && <DeveloperSettings onSignedLab={onSignedLab} openBundledTest={settings.openBundledTest} openStateLab={settings.openStateLab} />}
      {room === 'about' && <AboutSettings />}
    </ScrollView>
  </>;
}
export function IdentitySettings(settings: SettingsActions) {
  const {styles, colors} = useShellStyles(createStyles);
  const {transition, formatNpub, actions} = useIdentityOwner();
  const state = useSyncExternalStore(transition.subscribe, transition.getSnapshot);
  const [room, setRoom] = useState<SettingsRoom | 'index'>('index');
  const [importing, setImporting] = useState(false);
  const [publicEntry, setPublicEntry] = useState(false);
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
  const goBack = () => {
    if (state.phase === 'deleting' || state.phase === 'switching') return;
    if (deletion) closeDeletion();
    else if (backupReview) {
      try { actions?.endSettings(); } catch { /* Unmount also revokes the native backup request. */ }
      setBackupReview(false);
    } else if (signedLab) setSignedLab(false);
    else if (state.pending) transition.cancel(state.pending);
    else if (publicEntry) setPublicEntry(false);
    else if (importing) closeImport();
    else if (room !== 'index') setRoom(parentRoom(room));
    else settings.closeSettings();
  };
  useImperativeHandle(settings.backHandler, () => goBack);
  if (deletion && actions) return <DeleteIdentity review={deletion} transition={transition} actions={actions} npub={formatNpub(deletion.pubkey)}
      busy={state.phase === 'deleting'} onClose={closeDeletion} />;
  if (backupReview && actions) return <IdentityBackup actions={actions} session={state.session} npub={formatNpub(state.session.vault.selectedPubkey)} reviewing
      onReview={() => setBackupReview(true)} onClose={() => setBackupReview(false)} Action={Action} />;
  if (developerToolsEnabled && signedLab) return <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
    <PublishedHostLab onClose={() => setSignedLab(false)} sessionAuthority={() => transition.sessionAuthority()} />
  </ScrollView>;
  if (state.phase === 'deleting' || state.phase === 'switching') return <View style={styles.body}>
    <ActivityIndicator color={colors.accent} /><Text accessibilityRole="header" style={styles.title}>{state.phase === 'deleting' ? 'Finishing identity action…' : 'Updating account…'}</Text>
  </View>;
  if (state.pending) return <ConfirmIdentity pending={state.pending} transition={transition} npub={formatNpub(state.pending.pubkey)} />;
  const failure = state.failure && <Text testID="identity-change-error" accessibilityLiveRegion="polite" style={styles.detail}>{failureMessage(state.failure)}</Text>;
  if (publicEntry) return <>{failure}<PublicIdentity transition={transition} onClose={() => setPublicEntry(false)} /></>;
  if (importing) return <>{failure}<ImportIdentity transition={transition} onClose={closeImport} /></>;
  return <SettingsRooms settings={settings} room={room} open={setRoom} onBack={goBack} failure={failure}
    onSignedLab={() => setSignedLab(true)} identity={{session: state.session, onBackup: () => setBackupReview(true),
      onCloseBackup: () => setBackupReview(false), onDelete: pubkey => setDeletion({pubkey, session: state.session}),
      onImport: () => setImporting(true), onPublic: () => setPublicEntry(true)}} />;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  body: { padding: 24, paddingTop: 12, paddingBottom: 40, gap: 16 },
  index: {paddingHorizontal: 24, paddingBottom: 24, gap: 10},
  title: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
  npub: { fontFamily: fonts.mono, color: colors.text, fontSize: 12, lineHeight: 20, },
  input: { fontFamily: fonts.body, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 0, minHeight: 56, padding: 16, fontSize: 16 },
  identity: { padding: 16, gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 0 },
  identitySelect: { minHeight: 56, gap: 10 },
  action: { padding: 18, minHeight: 56, borderRadius: 0, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
});
