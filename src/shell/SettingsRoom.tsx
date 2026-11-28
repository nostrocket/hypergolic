import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { ShellPressable } from './ShellPressable';
import { ShellTextInput } from './ShellTextInput';
import { displayFontSize, useShellStyles, type ShellFonts, type ShellPalette } from './theme';

interface RoomAction {
  label: string;
  testID: string;
  onPress(): void;
  disabled?: boolean;
}

export function SettingsRoomHeader({ title, onBack, action }: { title: string; onBack(): void; action?: RoomAction | undefined }) {
  const { styles } = useShellStyles(createStyles);
  const { fontScale } = useWindowDimensions();
  return <View style={styles.header}>
    <ShellPressable accessibilityRole="button" accessibilityLabel="Back" testID="settings-room-back" onPress={onBack} style={styles.back}>
      <View style={styles.chevron} />
    </ShellPressable>
    <Text accessibilityRole="header" style={[styles.title, { fontSize: displayFontSize(24, fontScale) }]}>{title}</Text>
    {action && <ShellPressable accessibilityRole="button" testID={action.testID} onPress={action.onPress} disabled={action.disabled} style={styles.headerAction}>
      <Text style={styles.actionText}>{action.label}</Text>
    </ShellPressable>}
  </View>;
}

export function SettingsComposer({ children }: { children: ReactNode }) {
  const { styles } = useShellStyles(createStyles);
  return <ScrollView style={styles.composer} contentContainerStyle={styles.controls} keyboardShouldPersistTaps="handled">
    {children}
  </ScrollView>;
}

export function SettingsField({ style, ...props }: TextInputProps) {
  const { styles, colors } = useShellStyles(createStyles);
  return <ShellTextInput autoCorrect={false} autoCapitalize="none" autoComplete="off" placeholderTextColor={colors.muted}
    cursorColor={colors.accent} {...props} style={[styles.field, style]} />;
}

export function SettingsPrimary({ label, onPress, testID, disabled }: RoomAction) {
  const { styles } = useShellStyles(createStyles);
  return <ShellPressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={[styles.primary, disabled && styles.disabled]}>
    <Text style={[styles.primaryText, disabled && styles.disabledText]}>{label}</Text>
  </ShellPressable>;
}

const createStyles = (c: ShellPalette, f: ShellFonts) => StyleSheet.create({
  header: { minHeight: 60, paddingLeft: 8, paddingRight: 24, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', backgroundColor: c.background },
  back: { alignItems: 'center', justifyContent: 'center' },
  chevron: { width: 9, height: 9, borderLeftWidth: 1.5, borderBottomWidth: 1.5, borderColor: c.text, transform: [{ rotate: '45deg' }] },
  title: { flex: 1, color: c.text, fontFamily: f.display },
  headerAction: { justifyContent: 'center', maxWidth: '48%', marginLeft: 8 },
  actionText: { color: c.accent, fontFamily: f.medium, fontSize: 14, textAlign: 'right' },
  composer: { flexGrow: 0, flexShrink: 1, backgroundColor: c.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.subtle },
  controls: { gap: 8, paddingHorizontal: 24, paddingTop: 9, paddingBottom: 12 },
  field: { minHeight: 49, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderRadius: 5, borderColor: c.border,
    color: c.text, backgroundColor: c.background, fontSize: 15, fontFamily: f.mono },
  primary: { minHeight: 49, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 5, backgroundColor: c.primary },
  primaryText: { color: c.onPrimary, fontSize: 14, fontFamily: f.strong, letterSpacing: 1.1, textTransform: 'uppercase', textAlign: 'center' },
  disabled: { backgroundColor: c.subtle },
  disabledText: { color: c.muted },
});
