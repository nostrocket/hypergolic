import { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import { RelaySettingsError, type RelayRole, type RelaySettingsService, type RelaySettingsSnapshot } from '../network/relay-settings.ts';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

function message(error: unknown): string {
  if (error instanceof RelaySettingsError) {
    if (error.code === 'INVALID_RELAY_URL') return 'Enter a valid secure WebSocket URL using wss:// and a public DNS host.';
    if (error.code === 'DUPLICATE_RELAY') return 'That relay is already in this list.';
    if (error.code === 'RELAY_LIMIT_EXCEEDED') return 'This list can contain up to 16 relays.';
  }
  return 'The app could not confirm this change. Reopen settings to check the saved relay list.';
}
export function RelaySettings({ service }: { service: RelaySettingsService | null }) {
  const { styles, colors } = useShellStyles(createStyles);
  const [snapshot, setSnapshot] = useState<RelaySettingsSnapshot>(() => service?.getSettings() ?? { networkRelays: [], lookupRelays: [] });
  const [role, setRole] = useState<RelayRole>('network');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = async (action: () => Promise<RelaySettingsSnapshot>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setError('');
    try { setSnapshot(await action()); return true; }
    catch (reason) { setError(message(reason)); return false; }
    finally { setBusy(false); }
  };
  const add = () => {
    Keyboard.dismiss();
    const value = input;
    void update(() => service!.addRelay(role, value)).then(saved => { if (saved) setInput(''); });
  };
  const relays = role === 'network' ? snapshot.networkRelays : snapshot.lookupRelays;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.heading}>Relays</Text>
    <Text style={styles.detail}>Network relays are the destinations for approved event publication. Lookup relays will find napplet manifests. These lists are stored on this device.</Text>
    {service === null && <Text accessibilityLiveRegion="polite" testID="relay-settings-unavailable" style={styles.error}>Saved relay settings are unavailable. Identity and napplets remain usable; signing requests cannot proceed until relay storage is available.</Text>}
    {service !== null && <>
    <View style={styles.switches}>
      {(['network', 'lookup'] as const).map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: role === item }}
        testID={`relay-role-${item}`} onPress={() => { setRole(item); setError(''); }} style={[styles.role, role === item && styles.activeRole]}>
        <Text style={styles.roleText}>{item === 'network' ? 'Network' : 'Lookup'}</Text>
      </Pressable>)}
    </View>
    {relays.map(relay => <View key={relay} style={styles.relayRow}>
      <Text selectable style={styles.url}>{relay}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${relay}`} testID={`relay-remove-${role}`} disabled={busy}
        onPress={() => { void update(() => service!.removeRelay(role, relay)); }} style={styles.remove}>
        <Text style={styles.removeText}>Remove</Text>
      </Pressable>
    </View>)}
    {relays.length === 0 && <Text style={styles.detail}>{role === 'network' ? 'No network relays. Approved signing requests cannot proceed until a network relay is added.' : 'No lookup relays. Manifest discovery will have no lookup destinations.'}</Text>}
    <TextInput accessibilityLabel={`Add ${role} relay`} testID={`relay-input-${role}`} autoCapitalize="none" autoCorrect={false} keyboardType="url"
      autoComplete="off" value={input} onChangeText={value => { setInput(value); setError(''); }} onSubmitEditing={add}
      placeholder="wss://relay.example.org" placeholderTextColor={colors.muted} style={styles.input} returnKeyType="done" />
    <Pressable accessibilityRole="button" testID={`relay-add-${role}`} disabled={busy || input.trim() === ''} onPress={add} style={[styles.button, styles.subdued]}>
      <Text style={styles.buttonText}>Add {role} relay</Text>
    </Pressable>
    <Pressable accessibilityRole="button" testID={`relay-restore-${role}`} disabled={busy} onPress={() => { void update(() => service!.restoreDefaults(role)); }} style={[styles.button, styles.subdued]}>
      <Text style={styles.buttonText}>Restore {role} defaults</Text>
    </Pressable>
    {error !== '' && <Text accessibilityLiveRegion="polite" testID="relay-settings-error" style={styles.error}>{error}</Text>}
    </>}
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  section: { gap: 14 }, heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 22 },
  switches: { flexDirection: 'row', gap: 10 }, role: { flex: 1, alignItems: 'center', padding: 13, borderRadius: 0, borderWidth: 1, borderColor: colors.border },
  activeRole: { backgroundColor: colors.surface }, roleText: { fontFamily: fonts.strong, color: colors.text, fontSize: 15, },
  relayRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderRadius: 0, backgroundColor: colors.surface },
  url: { fontFamily: fonts.mono, flex: 1, color: colors.text, fontSize: 13, },
  remove: { padding: 9 }, removeText: { fontFamily: fonts.strong, color: colors.accent, fontSize: 14, },
  input: { fontFamily: fonts.body, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 0, minHeight: 54, padding: 14, fontSize: 15 },
  button: { padding: 15, minHeight: 52, borderRadius: 0, alignItems: 'center' }, subdued: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14, }, error: { fontFamily: fonts.body, color: colors.accent, fontSize: 14, lineHeight: 21 },
});
