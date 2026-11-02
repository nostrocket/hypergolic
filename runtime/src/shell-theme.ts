import type { Theme } from '@napplet/nap/theme';
import { createThemeService } from '@kehto/services';
import { shellPalette } from '../../src/shell/palette';

/** Existing theme recipients can follow the same system appearance as native chrome. */
export function createShellTheme(publish: (theme: Theme) => void) {
  const appearance = window.matchMedia('(prefers-color-scheme: light)');
  const current = () => {
    const palette = shellPalette(appearance.matches ? 'light' : 'dark');
    return { colors: { background: palette.background, text: palette.text, primary: palette.accent } };
  };
  const theme = createThemeService({ initialTheme: current(), onBroadcast: envelope => publish(envelope.theme) });
  const apply = () => {
    document.documentElement.style.colorScheme = appearance.matches ? 'light' : 'dark';
    document.body.style.backgroundColor = current().colors.background;
  };
  const changed = () => { apply(); theme.publishTheme(current()); };
  apply();
  appearance.addEventListener('change', changed);
  return { theme, close: () => appearance.removeEventListener('change', changed) };
}
