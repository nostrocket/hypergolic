import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { ShellPressable } from './ShellPressable';
import { IdentityBackup } from './IdentityBackup';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';
import { VaultError } from '../security/identity-vault-model';
import { signerFailureMessage, signingMethodAction, signingMethodTitle, type SigningMethod, type SigningMethodsSnapshot } from '../security/signing-methods';
import type { IdentitySession, IdentityTransition } from '../security/identity-transition';
import type { IdentitySettingsActions } from '../security/native-identity-actions';

function Action({ title, testID, onPress, subdued = false }: {
  title: string; testID: string; onPress(): void; subdued?: boolean;
}) {
  const { styles } = useShellStyles(createStyles);
  return <ShellPressable accessibilityRole="button" testID={testID} onPress={onPress} style={styles.action}>
    <Text style={[styles.actionText, subdued && styles.subdued]}>{title}</Text>
  </ShellPressable>;
}

function SavedMethod({ method, selected, transition, format, refresh }: {
  method: SigningMethod; selected: boolean; transition: IdentityTransition; format(pubkey: string): string; refresh(): void;
}) {
  const { styles } = useShellStyles(createStyles);
  const title = signingMethodTitle(method.kind);
  return <View style={styles.method}>
    <Text style={styles.heading}>{title}{selected ? ' · Selected' : ''}</Text>
    {method.kind === 'nip46' && <>
      <Text style={styles.detail}>Signer identity</Text>
      <Text selectable testID="signer-peer" style={styles.key}>{format(method.peerPubkey)}</Text>
      <Text style={styles.detail}>Signer relays</Text>
      {method.relays.map(relay => <Text selectable key={relay} style={styles.key}>{relay}</Text>)}
      <Text style={styles.detail}>This connection is saved. Availability is checked when you sign.</Text>
      <Action title="Check for relay changes" testID="signer-refresh-relays" onPress={refresh} />
      <Action title="Disconnect remote signer" testID="signer-disconnect" onPress={() => transition.prepareDisconnect()} subdued />
    </>}
    {method.kind === 'nip55' && <>
      <Text style={styles.detail}>Signer app</Text>
      <Text selectable testID="signer-package" style={styles.key}>{method.packageName}</Text>
      <Text style={styles.detail}>Signing opens this app on your phone. If its installed identity changes, connect it again.</Text>
      <Action title="Disconnect signer app" testID="signer-disconnect-android" onPress={() => transition.prepareDisconnect('nip55')} subdued />
    </>}
    {!selected && <Action title={signingMethodAction(method.kind)} testID={`signer-select-${method.kind}`}
      onPress={() => transition.prepareSigningMethod(method.kind)} />}
  </View>;
}

type SettingsProps = {
  transition: IdentityTransition; session: IdentitySession; actions?: IdentitySettingsActions;
  format(pubkey: string): string; onBackup(): void; onCloseBackup(): void;
};

/** Connection secrets are entered and confirmed by the native signer. */
function Methods({ transition, session, actions, format, onBackup, onCloseBackup, retry }: SettingsProps & { retry(): void }) {
  const { styles, colors } = useShellStyles(createStyles);
  const [methods, setMethods] = useState<SigningMethodsSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void transition.getSigningMethods().then(value => { if (active) setMethods(value); }).catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; transition.cancelRemotePreparation(); };
  }, [transition]);
  const prepare = (kind: 'connect' | 'refresh' | 'android') => {
    if (connecting) return;
    setConnecting(true); setError('');
    const preparation = kind === 'android' ? transition.prepareAndroidSigner()
      : kind === 'refresh' ? transition.prepareRemoteRefresh() : transition.prepareRemoteConnection();
    void preparation.catch(failure => {
      setError(signerFailureMessage(failure instanceof VaultError ? failure.code : undefined));
    }).finally(() => setConnecting(false));
  };
  if (loadFailed) return <View style={styles.group}>
    <Text accessibilityLiveRegion="polite" style={styles.detail}>Signing methods could not be read.</Text>
    <Action title="Try again" testID="signer-methods-retry" onPress={retry} />
  </View>;
  if (!methods) return <View style={styles.group}><ActivityIndicator color={colors.accent} /><Text style={styles.detail}>Reading signing methods…</Text></View>;
  if (connecting) return <View style={styles.group}>
    <ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={styles.detail}>Waiting for your signer…</Text>
    <Action title="Cancel signer request" testID="signer-connect-cancel" onPress={() => transition.cancelRemotePreparation()} subdued />
  </View>;
  const hasLocal = methods.methods.some(method => method.kind === 'local');
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Signing method</Text>
    {methods.selectedMethod === null && <Text testID="signer-no-selection" style={styles.detail}>No signing method is selected. Choose a saved method or connect a signer to sign requests.</Text>}
    {methods.methods.map(method => <SavedMethod key={method.kind} method={method} selected={method.kind === methods.selectedMethod} transition={transition} format={format} refresh={() => prepare('refresh')} />)}
    {hasLocal && methods.selectedMethod !== 'local' && <Text testID="signer-local-copy" style={styles.detail}>A local key copy is still stored on this device. Selecting another signer does not delete it.</Text>}
    {hasLocal && actions && <>
      <IdentityBackup actions={actions} session={session} npub={format(session.vault.selectedPubkey)} reviewing={false}
        onReview={onBackup} onClose={onCloseBackup} Action={Action} />
      <Action title="Remove local key" testID="signer-delete-local-key" onPress={() => transition.prepareDeleteLocalKey()} subdued />
    </>}
    {error !== '' && <Text testID="signer-connect-error" accessibilityLiveRegion="polite" style={styles.detail}>{error}</Text>}
    <Action title="Connect remote signer" testID="signer-connect" onPress={() => prepare('connect')} />
    {Platform.OS === 'android' && <Action title="Connect Android signer app" testID="signer-connect-android" onPress={() => prepare('android')} />}
  </View>;
}

export function SignerSettings(props: SettingsProps) {
  const [attempt, setAttempt] = useState(0);
  return <Methods key={`${props.session.vault.vaultId}:${props.session.vault.revision}:${attempt}`} {...props} retry={() => setAttempt(value => value + 1)} />;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  group: { gap: 16 }, method: { gap: 10, borderBottomWidth: 1, borderColor: colors.border, paddingBottom: 16 },
  title: { fontFamily: fonts.display, fontSize: 24, color: colors.text },
  heading: { fontFamily: fonts.medium, fontSize: 18, color: colors.text },
  detail: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: colors.muted },
  key: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, color: colors.text },
  action: { minHeight: 48, justifyContent: 'center', paddingVertical: 10 },
  actionText: { fontFamily: fonts.strong, fontSize: 16, color: colors.accent }, subdued: { color: colors.muted },
});
