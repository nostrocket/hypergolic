/** Shared shell colors. Guest documents choose whether to use the theme service. */
export const darkPalette = {
  background: '#080F17', surface: '#111D29', raised: '#1C2B3B',
  text: '#EEF3F7', muted: '#AFBDCB', accent: '#F5A04B', border: '#3C4C5D',
  primary: '#EEF3F7', onPrimary: '#080F17', onAccent: '#18110B',
  subtle: '#263646', glass: 'rgba(17,29,41,0.92)', shade: 'rgba(2,6,10,0.76)',
} as const;

export type ShellPalette = { readonly [K in keyof typeof darkPalette]: string };

export const lightPalette: ShellPalette = {
  background: '#FFFFFF', surface: '#F7F8FA', raised: '#EEF1F4',
  text: '#17202A', muted: '#5E6975', accent: '#AA4708', border: '#AAB5C1',
  primary: '#17202A', onPrimary: '#FFFFFF', onAccent: '#FFFFFF',
  subtle: '#E3E7EB', glass: 'rgba(247,248,250,0.96)', shade: 'rgba(15,24,36,0.44)',
};

export function shellPalette(scheme: string | null | undefined): ShellPalette {
  return scheme === 'light' ? lightPalette : darkPalette;
}
