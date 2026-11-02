import type { ReactNode } from 'react';
import { useFonts } from 'expo-font';
import { fallbackFonts, shellFonts, ShellFontContext } from './theme';

/** Fonts are bundled; appearance never needs a network request or delays identity recovery. */
export function ShellAppearance({ children }: { children: ReactNode }) {
  const [loaded] = useFonts({
    'Barlow-Light': require('../../assets/fonts/Barlow-Light.ttf'),
    'Barlow-Regular': require('../../assets/fonts/Barlow-Regular.ttf'),
    'Barlow-Medium': require('../../assets/fonts/Barlow-Medium.ttf'),
    'Barlow-SemiBold': require('../../assets/fonts/Barlow-SemiBold.ttf'),
    'JetBrainsMono-Regular': require('../../assets/fonts/JetBrainsMono-Regular.ttf'),
  });
  return <ShellFontContext.Provider value={loaded ? shellFonts : fallbackFonts}>{children}</ShellFontContext.Provider>;
}
