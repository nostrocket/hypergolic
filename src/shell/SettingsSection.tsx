import { useState, type ReactNode } from 'react';
import {  StyleSheet, Text, View } from 'react-native';
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
  section: { borderTopWidth: 1, borderColor: colors.border },
  trigger: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 18 },
  label: { flex: 1, gap: 5 },
  title: { color: colors.text, fontFamily: fonts.medium, fontSize: 21 },
  detail: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  indicator: { color: colors.accent, fontFamily: fonts.body, fontSize: 28 },
  pressed: { opacity: 0.65 },
  content: { gap: 22, paddingBottom: 24 },
});
