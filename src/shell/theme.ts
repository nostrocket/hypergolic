import { createContext, useContext, useMemo } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { homePalette, shellPalette, type ShellPalette } from './palette';

// Static palette retained for isolated native test fixtures. Product UI uses the hook.
export { darkPalette as colors } from './palette';
export type { ShellPalette } from './palette';
export interface ShellFonts { readonly display: string; readonly body: string; readonly medium: string; readonly strong: string; readonly mono: string }
export const shellFonts: ShellFonts = {
  display: 'Barlow-Light', body: 'Barlow-Regular', medium: 'Barlow-Medium',
  strong: 'Barlow-SemiBold', mono: 'JetBrainsMono-Regular',
};
export const fallbackFonts: ShellFonts = {
  display: 'System', body: 'System', medium: 'System', strong: 'System',
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
};
export const ShellFontContext = createContext(fallbackFonts);

/** Styles update on an OS appearance change without remounting live napplets. */
export function useShellStyles<T>(createStyles: (colors: ShellPalette, fonts: ShellFonts) => T, wallpaper = false) {
  const scheme = useColorScheme();
  const colors = wallpaper ? homePalette(scheme) : shellPalette(scheme);
  const fonts = useContext(ShellFontContext);
  const styles = useMemo(() => createStyles(colors, fonts), [colors, fonts, createStyles]);
  return { colors, styles, isDark: scheme !== 'light' };
}

/** Keeps visible grips beside the guest viewport while touch targets remain larger. */
export const HANDLE_GUTTER = 14;

/** Display headings grow more slowly than body copy at accessibility sizes so whole words still fit. */
export function displayFontSize(base: number, fontScale: number): number {
  return Math.max(18, base / Math.sqrt(Math.max(1, fontScale)));
}
