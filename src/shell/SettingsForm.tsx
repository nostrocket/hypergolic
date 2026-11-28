import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ThumbAction } from './ThumbAction';
import { useShellStyles, type ShellPalette } from './theme';

export function SettingsForm({children, action}: {children: ReactNode; action?: {label: string; testID: string; onPress(): void}}) {
  const {styles} = useShellStyles(createStyles);
  return <>
    <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>{children}</ScrollView>
    {action && <View style={styles.dock}><ThumbAction {...action} /></View>}
  </>;
}

const createStyles = (colors: ShellPalette) => StyleSheet.create({
  body: { padding: 20, gap: 16 },
  dock: { paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
});
