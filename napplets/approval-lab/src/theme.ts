import { themeGet, themeOnChanged, type Theme } from '@napplet/sdk';
import { element } from './view';

const fallback = { background: '#140f0b', text: '#f3efeb', primary: '#e8805d' };
function applyColors(colors: Theme['colors']): void {
  const style = document.documentElement.style;
  style.setProperty('--bg', colors.background);
  style.setProperty('--text', colors.text);
  style.setProperty('--primary', colors.primary);
  // Derive native control appearance from the host background, not the OS theme.
  const hex = colors.background.slice(1);
  const rgb = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const luminance = [0, 2, 4].reduce((sum, offset, i) =>
    sum + parseInt(rgb.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][i]!, 0);
  style.colorScheme = luminance > 140 ? 'light' : 'dark';
}
function acceptTheme(theme: Theme): void {
  const colors = theme?.colors;
  if (!colors || ![colors.background, colors.text, colors.primary].every(
    (value) => typeof value === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value),
  )) {
    applyColors(fallback);
    element('theme-status').textContent = 'Local palette · invalid host colors';
    return;
  }
  applyColors(colors);
  element('theme-status').textContent = 'Host colors';
  // Remote fonts and media are deliberately unused: this fixture has no network capability.
}
export async function connectTheme(): Promise<void> {
  // SDK helpers check domain presence. An absent optional domain never blocks the fixture.
  // Subscribe first so an older get() response cannot overwrite a newer pushed theme.
  let changed = false;
  try {
    const subscription = themeOnChanged((theme) => {
      changed = true;
      acceptTheme(theme);
    });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) subscription.close();
    });
  } catch {
    // A host may offer get() without the SDK's local onChanged binding.
  }
  try {
    const theme = await themeGet();
    if (!changed) acceptTheme(theme);
  } catch {
    if (!changed) element('theme-status').textContent = 'Local palette · host theme unavailable';
  }
}
