import { TrustedBand } from './TrustedBand';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRef } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

interface Props { title: string | null; onKeepOpen: () => void; onClose: () => void; onDismiss: () => void }
export function ClosePrompt({ title, onKeepOpen, onClose, onDismiss }: Props) {
  const { styles } = useShellStyles(createStyles);
  const keep = useRef<View>(null);
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={title !== null} transparent animationType="none" onRequestClose={onKeepOpen} onDismiss={onDismiss} onShow={() => {
      keep.current?.focus();
      if (keep.current) AccessibilityInfo.sendAccessibilityEvent(keep.current, 'focus');
    }}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal><TrustedBand label="Close napplet" /><ScrollView contentContainerStyle={styles.dialog}>
          <Text accessibilityRole="header" style={styles.title}>Close {title}?</Text>
          <Text style={styles.body}>Unsaved work may be lost. Saved data will remain available when you open it again.</Text>
          <Pressable ref={keep} testID="close-keep-open" accessibilityRole="button" onPress={onKeepOpen} style={({ pressed }) => [styles.keep, pressed && styles.pressed]}><Text style={styles.keepText}>Keep open</Text></Pressable>
          <Pressable testID="close-confirm" accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}><Text style={styles.closeText}>Close anyway</Text></Pressable>
        </ScrollView></View>
      </View>
    </Modal>
  );
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.shade, justifyContent: 'flex-end', paddingTop: 24 },
  sheet: { maxHeight: '90%', backgroundColor: colors.surface },
  dialog: { padding: 24, gap: 18 },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 28, letterSpacing: 0.2 },
  body: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
  keep: { minHeight: 50, borderRadius: 0, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', padding: 12 },
  keepText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  close: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 0, padding: 12 },
  closeText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
  pressed: { opacity: 0.7 },
});
