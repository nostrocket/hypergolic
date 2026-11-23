import type { Ref } from 'react';
import { Platform, StatusBar, StyleSheet, Text, type ViewInstance } from 'react-native';
import { Header, type ShellIdentity } from './Header';
import type { NappletDescriptor } from './workspace';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  overlay: {position: 'absolute', zIndex: 5, top: 4},
  left: {left: 4}, right: {right: 4}, header: {alignSelf: 'flex-start'},
  exit: {paddingHorizontal: 12, justifyContent: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 6},
  label: {fontFamily: fonts.strong, color: colors.text},
});
export function WorkspaceHeader({ fullscreen, exitPlacement, overview, home = false, focused, identity, disabled, menuAnchor, onSettings, onHome, onOverview, onMenu }: {
  exitPlacement: 'left' | 'right' | 'header' | null; fullscreen: boolean; overview: boolean; home?: boolean; focused: NappletDescriptor | undefined; identity?: ShellIdentity; disabled: boolean;
  menuAnchor: Ref<ViewInstance>; onSettings(): void; onHome(): void; onOverview(): void; onMenu(): void;
}) {
  const { isDark, styles } = useShellStyles(createStyles);
  const compact = !overview && focused !== undefined;
  return <>
    <StatusBar hidden={Platform.OS === 'ios' ? fullscreen : undefined} barStyle={isDark ? 'light-content' : 'dark-content'} />
    {fullscreen && exitPlacement && <ShellPressable testID="fullscreen-overview" accessibilityRole="button" disabled={disabled}
      onPress={onOverview} style={[styles.exit, exitPlacement !== 'header' && styles.overlay, styles[exitPlacement]]}><Text style={styles.label}>All napplets</Text></ShellPressable>}
    {!fullscreen && <Header title={overview ? 'Hypergolic' : focused?.title ?? 'Hypergolic'} identity={identity} disabled={disabled}
      compact={compact} wallpaper={home} menuAnchor={menuAnchor} onSettings={onSettings} onHome={onHome}
      onOverview={compact ? onOverview : undefined} onMenu={compact ? onMenu : undefined} />}
  </>;
}
