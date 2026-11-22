import type {CatalogEntry, Profile, Publication} from './catalog.ts';
import {artwork, button, node} from './dom.ts';
import type {ViewMedia} from './media.ts';
import {publicationTimestamp} from './publication-date.ts';

export function publicationAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function publisherLabel(app: Publication, profiles: ReadonlyMap<string, Profile>): string {
  return profiles.get(app.publisher)?.name || `${app.npub.slice(0, 12)}…${app.npub.slice(-4)}`;
}

export function updateRowPublishers(results: HTMLElement, visibleEntries: CatalogEntry[], profiles: ReadonlyMap<string, Profile>): void {
  const byPublisher = new Map(visibleEntries.map(({publication}) => [publication.publisher, publication]));
  for (const label of results.querySelectorAll<HTMLElement>('[data-publisher]')) {
    const app = byPublisher.get(label.dataset.publisher!);
    if (!app) continue;
    const text = 'by ' + publisherLabel(app, profiles);
    if (label.textContent !== text) label.textContent = text;
  }
}

export function publicationRow(entry: CatalogEntry, media: ViewMedia, profiles: ReadonlyMap<string, Profile>,
  showDetail: (entry: CatalogEntry, control: HTMLElement) => void, open?: HTMLButtonElement): HTMLLIElement {
  const app = entry.publication;
  const row = node('li', 'row');
  const cell = node('div', 'row-cell');
  const info = button('', 'row-info', event => showDetail(entry, event.currentTarget as HTMLElement));
  info.setAttribute('aria-label', `Details for ${app.title}`);
  info.dataset.row = app.address;
  const summary = node('span', 'row-summary');
  summary.append(node('strong', 'row-title', app.title));
  const metadata = node('span', 'row-metadata');
  const publisher = node('span', 'row-publisher', 'by ' + publisherLabel(app, profiles));
  publisher.dataset.publisher = app.publisher;
  publisher.title = app.npub;
  const date = publicationTimestamp(app.signed.event.created_at);
  const age = node('time', 'row-age', publicationAge(app.signed.event.created_at));
  if (date) {age.dateTime = date.iso; age.setAttribute('aria-label', 'Updated ' + date.label);}
  metadata.append(publisher, age);
  summary.append(metadata);
  if (app.description) summary.append(node('span', 'row-description', app.description));
  else summary.append(node('span', 'row-description', 'No description provided'));
  info.append(artwork(app, media), summary);
  cell.append(info);
  if (open) {
    open.dataset.open = app.address;
    cell.append(open);
  }
  row.append(cell);
  return row;
}
