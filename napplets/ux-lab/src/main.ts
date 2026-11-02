import { themeGet, themeOnChanged, type Theme } from '@napplet/sdk';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error('Missing fixture element: ' + id);
  return target as T;
}

const draft = element<HTMLTextAreaElement>('draft');
const counter = element<HTMLOutputElement>('counter');
const rail = element('rail');
let count = 0;
const markerButtons: HTMLButtonElement[] = [];

function renderDraft(): void {
  element('draft-count').textContent = draft.value.length + ' / 2000';
  element('draft-mirror').textContent = draft.value || 'No text yet.';
}
draft.addEventListener('input', renderDraft);
element('increment').addEventListener('click', () => {
  count += 1;
  counter.value = String(count);
});

for (let index = 1; index <= 10; index += 1) {
  const label = String(index).padStart(2, '0');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'marker';
  button.dataset.testid = 'marker-' + index;
  button.setAttribute('aria-label', 'Select marker ' + label);
  button.setAttribute('aria-pressed', 'false');
  const number = document.createElement('span');
  number.className = 'marker-number';
  number.textContent = label;
  const caption = document.createElement('span');
  caption.textContent = 'Select marker';
  button.append(number, caption);
  button.addEventListener('click', () => {
    for (const candidate of markerButtons) {
      candidate.setAttribute('aria-pressed', String(candidate === button));
    }
    element('selected').textContent = label;
  });
  markerButtons.push(button);
  rail.append(button);
}
rail.addEventListener('scroll', () => {
  element('scroll-x').textContent = String(Math.round(rail.scrollLeft));
}, { passive: true });

for (let index = 1; index <= 6; index += 1) {
  const label = String(index).padStart(2, '0');
  const marker = document.createElement('div');
  marker.className = 'vertical-marker';
  marker.dataset.testid = 'vertical-' + index;
  const heading = document.createElement('div');
  heading.className = 'marker-heading';
  const number = document.createElement('span');
  number.className = 'vertical-number';
  number.textContent = label;
  const caption = document.createElement('p');
  caption.textContent = 'Vertical marker';
  heading.append(number, caption);
  const controls = document.createElement('div');
  controls.className = 'edge-row';
  for (const side of ['Left', 'Right']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = side + ' edge';
    button.setAttribute('aria-label', side + ' edge at marker ' + label);
    button.dataset.testid = 'edge-' + side.toLowerCase() + '-' + index;
    button.addEventListener('click', () => {
      element('edge').textContent = side + ' / ' + label;
    });
    controls.append(button);
  }
  marker.append(heading, controls);
  element('markers').append(marker);
}

element('reset').addEventListener('click', () => {
  count = 0;
  counter.value = '0';
  draft.value = '';
  renderDraft();
  element('selected').textContent = 'None';
  element('edge').textContent = 'None';
  for (const button of markerButtons) button.setAttribute('aria-pressed', 'false');
  rail.scrollLeft = 0;
  element('scroll-x').textContent = '0';
  element('ready').textContent = 'Ready · instance reset';
  window.scrollTo(0, 0);
  element('increment').focus({ preventScroll: true });
});

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
async function connectTheme(): Promise<void> {
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

element('lab').dataset.ready = 'true';
element('ready').textContent = 'Ready · temporary state only';
void connectTheme();
