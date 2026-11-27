import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { devicePrivacy, type DevicePrivacyPreferences } from '../security/device-privacy';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

const options = [
  ['workspace', 'Lock Hypergolic', 'Unlock on launch, after a minute away, or when you lock your phone.'],
  ['local', 'Confirm local signatures', 'Authenticate for each reviewed event signed with this account’s local key.'],
  ['external', 'Confirm before opening an external signer', 'Require this device’s confirmation before sending this account’s reviewed event to its signer.'],
] as const;

export function DevicePrivacySettings({ pubkey }: { pubkey: string }) {
  const { styles } = useShellStyles(createStyles);
  const [preferences, setPreferences] = useState<DevicePrivacyPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void devicePrivacy().preferences(pubkey).then(result => { if (active) setPreferences(result); })
      .catch(() => { if (active) setMessage('Privacy settings could not be read.'); });
    return () => { active = false; };
  }, [pubkey]);
  async function toggle(mode: keyof DevicePrivacyPreferences) {
    if (!preferences || busy) return;
    setBusy(true); setMessage('');
    try {
      if (await devicePrivacy().configure(mode, pubkey, !preferences[mode])) setPreferences(await devicePrivacy().preferences(pubkey));
      else setMessage('Your device did not confirm the change.');
    } catch { setMessage('Device confirmation is unavailable.'); }
    finally { setBusy(false); }
  }
  return <View style={styles.group}>
    {preferences && options.map(([mode, title, explanation]) => <ShellPressable key={mode} accessibilityRole="switch"
      accessibilityState={{ checked: preferences[mode], disabled: busy }} accessibilityLabel={title} accessibilityHint={explanation}
      disabled={busy} onPress={() => { void toggle(mode); }} style={styles.action}>
      <Text style={styles.label}>{title} · {preferences[mode] ? 'On' : 'Off'}</Text>
      <Text style={styles.detail}>{explanation}</Text>
    </ShellPressable>)}
    {preferences?.workspace && <ShellPressable accessibilityRole="button" onPress={() => {
      void devicePrivacy().lock().catch(() => setMessage('Hypergolic could not lock.'));
    }} style={styles.action}><Text style={styles.label}>Lock now</Text></ShellPressable>}
    {message !== '' && <Text accessibilityLiveRegion="polite" style={styles.detail}>{message}</Text>}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  group: { gap: 8 },
  action: { minHeight: 48, paddingVertical: 8 },
  label: { color: colors.text, fontFamily: fonts.medium, fontSize: 16 },
  detail: { color: colors.muted, fontSize: 14 },
});
