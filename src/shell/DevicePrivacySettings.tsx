import {useEffect, useRef, useState} from 'react';
import {StyleSheet, Switch, Text, View} from 'react-native';
import {devicePrivacy, type DevicePrivacyPreferences} from '../security/device-privacy';
import {ShellPressable} from './ShellPressable';
import {useShellStyles, type ShellFonts, type ShellPalette} from './theme';

const options = [
  ['workspace', 'Lock Hypergolic', 'Unlocks on launch, after a minute away, or when you lock your phone.'],
  ['local', 'Confirm local signatures', 'Authenticate for each reviewed event signed with this account’s local key.'],
  ['external', 'Confirm before opening an external signer', 'Require this device’s confirmation before sending this account’s reviewed event to its signer.'],
] as const;

type PrivacyState = {pubkey: string; preferences: DevicePrivacyPreferences | null; message: string; busy: boolean};

export function useDevicePrivacyPreferences(pubkey: string) {
  const [state, setState] = useState<PrivacyState | null>(null);
  const owner = useRef<{pubkey: string; busy: boolean} | null>(null);
  const current = state?.pubkey === pubkey ? state : null;
  const preferences = current?.preferences ?? null;

  useEffect(() => {
    let active = true;
    const session = {pubkey, busy: false};
    owner.current = session;
    async function read() {
      let result: DevicePrivacyPreferences | null = null;
      let message = '';
      try { result = await devicePrivacy().preferences(pubkey); }
      catch { message = 'Privacy settings could not be read.'; }
      if (active) setState({pubkey, preferences: result, message, busy: false});
    }
    void read();
    return () => { active = false; owner.current = null; };
  }, [pubkey]);

  async function toggle(mode: keyof DevicePrivacyPreferences, value: boolean) {
    const session = owner.current;
    if (!session || session.pubkey !== pubkey || session.busy || !preferences || value === preferences[mode]) return;
    session.busy = true;
    setState({pubkey, preferences, message: '', busy: true});
    let next = preferences;
    let message = '';
    try {
      if (await devicePrivacy().configure(mode, pubkey, value)) next = {...preferences, [mode]: value};
      else message = 'Your device did not confirm the change.';
    } catch { message = 'Device confirmation is unavailable.'; }
    session.busy = false;
    if (owner.current === session) setState({pubkey, preferences: next, message, busy: false});
  }

  async function lockNow() {
    const session = owner.current;
    if (!session || session.pubkey !== pubkey || session.busy || !preferences?.workspace) return;
    try { await devicePrivacy().lock(); }
    catch {
      if (owner.current === session) setState({pubkey, preferences, busy: false, message: 'Hypergolic could not lock.'});
    }
  }
  return {preferences, message: current?.message ?? '', busy: current?.busy ?? false, toggle, lockNow};
}

export function DevicePrivacySettings({privacy}: {privacy: ReturnType<typeof useDevicePrivacyPreferences>}) {
  const {styles, colors, isDark} = useShellStyles(createStyles);
  const {preferences, busy, message, toggle, lockNow} = privacy;
  const trackOff = isDark ? '#3A4652' : '#C5C9CE';
  return <View>
    <Text style={styles.intro}>Workspace lock and signing confirmation.</Text>
    {preferences && options.map(([mode, title, explanation]) => {
      const checked = preferences[mode];
      const helper = mode === 'workspace' && !checked ? undefined : explanation;
      return <View key={mode} style={[styles.block, mode !== 'external' && styles.divider]}>
        <View style={styles.row}>
          <ShellPressable accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            focusable={false} disabled={busy} onPress={() => { void toggle(mode, !checked); }} style={styles.copy}>
            <Text style={styles.label}>{title}</Text>
            {helper && <Text style={styles.detail}>{helper}</Text>}
          </ShellPressable>
          <Switch testID={`device-privacy-${mode}`} accessibilityLabel={title} accessibilityHint={helper}
            hitSlop={8} disabled={busy} value={checked} onValueChange={value => { void toggle(mode, value); }}
            trackColor={{false: trackOff, true: isDark ? '#E29547' : colors.accent}} ios_backgroundColor={trackOff} thumbColor="#FFFFFF" />
        </View>
        {mode === 'workspace' && checked && <ShellPressable accessibilityRole="button" testID="device-privacy-lock-now"
          disabled={busy} onPress={() => { void lockNow(); }} style={styles.lockAction}>
          <Text style={styles.actionLabel}>Lock now</Text>
        </ShellPressable>}
      </View>;
    })}
    {message !== '' && <Text accessibilityLiveRegion="polite" style={styles.detail}>{message}</Text>}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  intro: {fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 21, marginBottom: 4},
  block: {paddingVertical: 12},
  divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.subtle},
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 16, minHeight: 44},
  copy: {flex: 1, gap: 4},
  label: {fontFamily: fonts.medium, color: colors.text, fontSize: 16, lineHeight: 21},
  detail: {fontFamily: fonts.body, color: colors.muted, fontSize: 14, lineHeight: 19},
  lockAction: {alignSelf: 'flex-start', justifyContent: 'center'},
  actionLabel: {fontFamily: fonts.medium, color: colors.accent, fontSize: 16},
});
