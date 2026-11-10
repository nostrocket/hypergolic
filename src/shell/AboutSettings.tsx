import { useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import { buildInfo } from '../config/build-info';
import { ShellPressable } from './ShellPressable';
import { SettingsSection } from './SettingsSection';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

const repository = 'https://github.com/nostrocket/hypergolic';
const links = [
  ['Website', 'https://hypergolic.space'],
  ['Releases and downloads', `${repository}/releases`],
  ['Help and feedback', `${repository}/issues`],
  ['Privacy', `${repository}/blob/main/docs/privacy.md`],
  ['Source and licenses', `${repository}/blob/main/docs/native-dependency-notices.md`],
] as const;

export function AboutSettings() {
  const { styles } = useShellStyles(createStyles);
  const [error, setError] = useState('');
  async function open(url: string) {
    setError('');
    try { await Linking.openURL(url); }
    catch { setError('The link could not be opened. Please try again.'); }
  }
  return <SettingsSection title="About Hypergolic" detail={`Version ${buildInfo.version}`} id="about">
    <Text selectable style={styles.detail}>Version {buildInfo.version} · Build {buildInfo.build}{buildInfo.development ? ' · Development' : ''}</Text>
    {links.map(([label, url]) => <ShellPressable key={url} accessibilityRole="link" accessibilityHint="Opens in your browser"
      onPress={() => { void open(url); }} style={styles.link}><Text style={styles.label}>{label}</Text></ShellPressable>)}
    {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.detail}>{error}</Text>}
  </SettingsSection>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  link: { paddingVertical: 14, justifyContent: 'center' },
  label: { fontFamily: fonts.medium, color: colors.accent, fontSize: 16 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 14, lineHeight: 21 },
});
