import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

export function SettingsSection({ title, detail, id, children }: { title: string; detail: string; id: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const { styles } = useShellStyles(createStyles);
  return <View style={styles.section}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} testID={`settings-section-${id}`} onPress={() => setExpanded(value => !value)} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
      <View style={styles.label}><Text style={styles.title}>{title}</Text><Text style={styles.detail}>{detail}</Text></View>
      <Text accessible={false} style={styles.indicator}>{expanded ? '−' : '+'}</Text>
    </Pressable>
    {expanded && <View style={styles.content}>{children}</View>}
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  section: { paddingHorizontal: 14 },
  trigger: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 11 },
  label: { flex: 1, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.strong, fontSize: 20 },
  detail: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  indicator: { color: colors.accent, fontFamily: fonts.body, fontSize: 28 },
  pressed: { opacity: 0.65 },
  content: { gap: 22, paddingBottom: 24 },
});
