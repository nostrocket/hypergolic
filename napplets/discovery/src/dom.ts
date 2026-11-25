import { identityArt } from './identity-art.ts';
import { accessIconPath } from './access-icon.ts';
import type { Media, Publication } from './catalog.ts';
import type { ViewMedia } from './media.ts';

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function find<T extends HTMLElement = HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing catalog control ${id}`);
  return result as T;
}

const paths = {
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  search: 'M21 21l-4.4-4.4m1.4-5.1a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  back: 'M15 5l-7 7 7 7',
  close: 'm6 6 12 12M18 6 6 18',
  chevron: 'm9 5 7 7-7 7',
  down: 'm5 9 7 7 7-7',
  profile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-6-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-9 8a7 7 0 0 1 12 0',
};

export function glyph(name: keyof typeof paths): SVGSVGElement {
  return outline(paths[name]);
}

export function accessGlyph(domain: string): SVGSVGElement {
  return outline(accessIconPath(domain));
}

function outline(pathData: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

export function button(label: string, className: string, action: (event: MouseEvent) => void): HTMLButtonElement {
  const result = node('button', className, label);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}

const initialColours = [
  ['#dfb679', '#39280e'], ['#8db9ad', '#173b35'], ['#91b0cc', '#1c324d'], ['#aca1cc', '#35294e'],
  ['#d3a1a8', '#47232b'], ['#b0bf88', '#2b3916'], ['#c8b79c', '#3f3120'], ['#b7a7bf', '#3d2c44'],
] as const;

function publicationSeed(app: Publication): number {
  const identity = `${app.publisher}:${app.identifier}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  return hash >>> 0;
}

export function publicationColours(app: Publication) {
  return initialColours[publicationSeed(app) % initialColours.length]!;
}

function titleInitials(app: Publication): HTMLElement {
  const words = app.title.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const initials = words.slice(0, 2).map(word => [...word][0]).join('').toUpperCase() || '?';
  const tile = node('span', 'app-initials', initials);
  const [background, ink] = publicationColours(app);
  tile.style.setProperty('--initials-background', background);
  tile.style.setProperty('--initials-ink', ink);
  return tile;
}

function detailPattern(app: Publication): HTMLElement {
  const tile = node('span', 'tile-pattern');
  const seed = publicationSeed(app);
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const bit = row * 3 + Math.min(column, 4 - column);
      const lit = (row === 2 && column === 2) || ((seed >>> bit) & 1);
      tile.append(node('i', lit ? 'lit' : ''));
    }
  }
  return tile;
}

export function artwork(app: Publication, media: ViewMedia, large = false): HTMLElement {
  const frame = node('span', large ? 'app-icon app-icon-large' : 'app-icon');
  frame.setAttribute('aria-hidden', 'true');
  frame.append(large ? detailPattern(app) : titleInitials(app));
  if (large) frame.style.setProperty('--address-art', identityArt(publicationSeed(app), publicationColours(app)[0]));
  if (app.icon) media.show(frame, app.icon, img => frame.replaceChildren(labelImage(img, '', 72, 72)));
  return frame;
}

function labelImage(result: HTMLImageElement, alt: string, width: number, height: number): HTMLImageElement {
  result.alt = alt;
  result.width = width;
  result.height = height;
  return result;
}

export function screenshot(anchor: HTMLElement, candidates: readonly Media[], media: ViewMedia): void {
  media.showFirstScreenshot(anchor, candidates, (img, descriptor) => {
    const frame = node('figure', 'preview');
    frame.append(labelImage(img, descriptor.alt || '', 800, 300));
    anchor.replaceChildren(frame);
  });
}
