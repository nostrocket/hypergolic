import { useEffect, useRef } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FrameCorners } from './FrameCorners';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

interface Props {
  title: string; disabled: boolean;
  onDismiss(): void; onOverview(): void; onSettings(): void; onClose(): void;
}

/** An in-shell overlay keeps menu dismissal and close/review dialogs in one navigation flow. */
export function WorkspaceMenu({ title, disabled, onDismiss, onOverview, onSettings, onClose }: Props) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  const done = useRef<View>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      done.current?.focus();
      if (done.current) AccessibilityInfo.sendAccessibilityEvent(done.current, 'focus');
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <View style={styles.overlay} accessibilityViewIsModal onAccessibilityEscape={onDismiss} testID="shell-workspace-menu">
    <ShellPressable accessibilityRole="button" accessibilityLabel="Dismiss napplet menu" onPress={onDismiss} style={styles.backdrop} />
    <View pointerEvents="box-none" style={[styles.position, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.frame}>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <ShellPressable ref={done} testID="shell-menu-done" accessibilityRole="button" onPress={onDismiss} style={styles.done}><Text style={styles.doneText}>Done</Text></ShellPressable>
        </View>
        <ScrollView contentContainerStyle={styles.actions}>
          <ShellPressable testID="shell-menu-overview" accessibilityRole="button" disabled={disabled} onPress={onOverview} style={styles.action}><Text style={styles.actionText}>All napplets</Text><Text accessible={false} style={styles.symbol}>›</Text></ShellPressable>
          <ShellPressable testID="shell-menu-settings" accessibilityRole="button" disabled={disabled} onPress={onSettings} style={styles.action}><Text style={styles.actionText}>Settings</Text><Text accessible={false} style={styles.symbol}>›</Text></ShellPressable>
          <ShellPressable testID="shell-close" accessibilityRole="button" accessibilityLabel={`Close ${title}`} disabled={disabled} onPress={onClose} style={styles.action}><Text style={styles.actionText}>Close napplet</Text><Text accessible={false} style={styles.symbol}>×</Text></ShellPressable>
        </ScrollView>
        <FrameCorners />
      </View>
    </View>
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 30 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.shade },
  position: { flex: 1, paddingHorizontal: 12, alignItems: 'center' },
  frame: { width: '100%', maxWidth: 480, maxHeight: '90%', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 8, borderBottomWidth: 1, borderBottomColor: colors.subtle },
  title: { flex: 1, fontFamily: fonts.medium, fontSize: 20, color: colors.text, paddingVertical: 12 },
  done: { paddingHorizontal: 10, justifyContent: 'center' },
  doneText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  actions: { paddingHorizontal: 18 },
  action: { minHeight: 52, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: 1, borderBottomColor: colors.subtle },
  actionText: { flex: 1, fontFamily: fonts.body, fontSize: 17, color: colors.text },
  symbol: { fontFamily: fonts.body, fontSize: 20, color: colors.muted },
});
