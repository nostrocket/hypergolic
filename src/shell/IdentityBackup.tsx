import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import type { IdentitySettingsActions } from '../security/native-identity-actions';
import type { IdentitySession } from '../security/identity-transition';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

type ActionProps = Readonly<{ title: string; testID: string; onPress: () => void; subdued?: boolean }>;
type BackupProps = Readonly<{
  actions: IdentitySettingsActions;
  session: IdentitySession;
  npub: string;
  reviewing: boolean;
  onReview: () => void;
  onClose: () => void;
  Action: (props: ActionProps) => JSX.Element;
}>;

/** A trusted-shell review. The native panel owns every secret value and reveal control. */
export function IdentityBackup({ actions, session, npub, reviewing, onReview, onClose, Action }: BackupProps) {
  const { styles, colors } = useShellStyles(createStyles);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const selectedPubkey = session.vault.selectedPubkey;
  useEffect(() => {
    let mounted = true;
    void actions.isBackupAvailable().then(value => { if (mounted) setAvailable(value); });
    return () => { mounted = false; };
  }, [actions]);
  const close = useCallback(() => {
    generation.current += 1;
    try { actions.cancelBackup(); } catch { /* Always end the native Settings session. */ }
    try { actions.endSettings(); } catch { /* The local epoch is already revoked. */ }
    setBusy(false); onClose();
  }, [actions, onClose]);
  useEffect(() => () => {
    generation.current += 1;
    try { actions.cancelBackup(); } catch { /* Parent Settings cleanup also ends native authority. */ }
  }, [actions, session]);
  const show = () => {
    if (busy || (!reviewing && available !== true)) return;
    const request = ++generation.current;
    setBusy(true); setError(false);
    void (async () => {
      try {
        await actions.beginSettings({ selectedPubkey, revision: session.vault.revision });
        if (generation.current !== request) return;
        await actions.showBackup({ pubkey: selectedPubkey, selectedPubkey, revision: session.vault.revision });
        if (generation.current !== request) return;
        setBusy(false);
        generation.current += 1;
        onClose();
      } catch {
        if (generation.current === request) setError(true);
      } finally {
        if (generation.current === request) setBusy(false);
      }
    })();
  };
  if (!reviewing) return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Identity backup</Text>
    <Text style={styles.detail}>Keep a backup under your control. Hypergolic does not send your nsec to cloud storage.</Text>
    {available === true ? <Action title="Back up selected identity" testID="identity-backup-start" onPress={onReview} subdued />
      : <Text testID="identity-backup-unavailable" style={styles.detail}>{available === null ? 'Checking device authentication…' : 'Device authentication is unavailable. Enable a device passcode or supported biometric authentication to back up an identity.'}</Text>}
  </View>;
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>{busy ? 'Confirm on your device' : 'Back up identity?'}</Text>
    <Text selectable testID="identity-backup-npub" style={styles.npub}>{npub}</Text>
    <Text style={styles.detail}>After authentication, your private key appears for you to write down.</Text>
    {Platform.OS === 'ios' && <Text testID="identity-backup-ios-capture-warning" style={styles.detail}>iOS cannot prevent screenshots. The key hides while recording or leaving the app.</Text>}
    {error && <Text testID="identity-backup-error" accessibilityLiveRegion="polite" style={styles.detail}>Backup was not completed. Your identity is unchanged.</Text>}
    {busy && <ActivityIndicator color={colors.accent} />}
    <Action title="Cancel" testID="identity-backup-cancel" onPress={close} subdued />
    {!busy && <Action title="Authenticate and show backup" testID="identity-backup-confirm" onPress={show} />}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => ({
  group: { gap: 20 },
  title: { fontSize: 28, fontFamily: fonts.display, color: colors.text },
  detail: { color: colors.muted, fontFamily: fonts.body, fontSize: 16, lineHeight: 24 },
  npub: { color: colors.text, fontSize: 13, lineHeight: 22, fontFamily: fonts.mono },
});
