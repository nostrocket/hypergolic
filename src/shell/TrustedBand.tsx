import { StyleSheet, Text, View } from 'react-native';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

/** A shell-owned edge, outside the bounded guest viewport. It is not publisher verification. */
export function TrustedBand({ label = 'Trusted request' }: { label?: string }) {
  const { styles } = useShellStyles(createStyles);
  return <View style={styles.band} accessible accessibilityLabel={`Hypergolic. ${label}`}>
    <View style={styles.brand}>
      <View style={styles.mark}><View style={styles.core} /></View>
      <Text style={styles.wordmark}>Hypergolic</Text>
    </View>
    <Text style={styles.label}>{label}</Text>
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  band: { minHeight: 44, paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: colors.accent },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: { width: 15, height: 15, borderWidth: 1.5, borderColor: colors.onAccent, alignItems: 'center', justifyContent: 'center' },
  core: { width: 5, height: 5, backgroundColor: colors.onAccent },
  wordmark: { fontFamily: fonts.strong, color: colors.onAccent, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' },
  label: { fontFamily: fonts.medium, color: colors.onAccent, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase' },
});
