import { useSyncExternalStore, type ReactNode } from 'react';
import { Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import { ThumbAction } from './ThumbAction';
import { useShellStyles, type ShellPalette } from './theme';

function observeKeyboard(change: () => void) {
  const shown = Keyboard.addListener('keyboardDidShow', change);
  const hidden = Keyboard.addListener('keyboardDidHide', change);
  return () => { shown.remove(); hidden.remove(); };
}

// The keyboard provides its own thumb-zone Go action while the address or public key is being edited.
export function SettingsDock({children}: {children: ReactNode}) {
  const {styles} = useShellStyles(createStyles);
  const keyboard = useSyncExternalStore(observeKeyboard, () => Keyboard.isVisible());
  return keyboard ? null : <View style={styles.dock}>{children}</View>;
}

export function SettingsForm({children, action}: {children: ReactNode; action?: {label: string; testID: string; onPress(): void}}) {
  const {styles} = useShellStyles(createStyles);
  return <>
    <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>{children}</ScrollView>
    {action && <SettingsDock><ThumbAction {...action} /></SettingsDock>}
  </>;
}

const createStyles = (colors: ShellPalette) => StyleSheet.create({
  body: { padding: 20, gap: 16 },
  dock: { paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
});
