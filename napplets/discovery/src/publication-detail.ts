import {accessCopy} from './access-copy.ts';
import type {CatalogEntry, Profile, Publication} from './catalog.ts';
import {accessGlyph, artwork, button, find, glyph, node, publicationColours, screenshot} from './dom.ts';
import {canOpen} from './host.ts';
import type {ViewMedia} from './media.ts';
import type {RevisionHistory} from './pager.ts';
import {publicationTimestamp} from './publication-date.ts';
import {recommendControl} from './recommendations.ts';

function accessList(names: string[]): string {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
}

function detailSection(title: string): HTMLElement {
  const section = node('section', 'detail-section');
  section.append(node('h2', '', title));
  return section;
}

function capabilities(section: HTMLElement, label: string, names: string[]): void {
  if (!names.length) return;
  section.append(node('h3', 'cap-group', label));
  const list = node('ul', 'capabilities');
  list.setAttribute('role', 'list');
  for (const name of names) {
    const {name:title,description} = accessCopy(name);
    const row = node('li', 'cap-row');
    row.dataset.requirement = label.toLowerCase();
    const icon = node('span', 'cap-icon');
    icon.append(accessGlyph(name));
    const copy = node('div');
    copy.append(node('strong', '', title), node('p', 'muted', description));
    row.append(icon, copy);
    list.append(row);
  }
  section.append(list);
}

function reference(label: string, value: string): HTMLElement {
  const field = node('div', 'reference');
  field.append(node('span', 'muted', label), node('code', '', value));
  return field;
}

export function updatePublisher(app: Publication, profile?: Profile): void {
  const publisher = find('publisher-name');
  publisher.textContent = profile?.name || `${app.npub.slice(0, 16)}…${app.npub.slice(-8)}`;
  const about = find('publisher-about');
  about.textContent = profile?.about || (profile?.name ? '' : 'No verified publisher profile is available.');
  about.hidden = !about.textContent;
}

function publisherDisclosure(app: Publication): HTMLElement {
  const publisher = node('div', 'detail-publisher');
  const profile = node('details', 'publisher');
  const summary = node('summary');
  const profileLabel = node('span');
  profileLabel.id = 'publisher-name';
  summary.append(glyph('profile'), profileLabel, glyph('chevron'));
  const profileAbout = node('p', 'description');
  profileAbout.id = 'publisher-about';
  profile.append(summary, profileAbout, reference('Signing key', app.npub));
  publisher.append(profile);
  return publisher;
}

function accessTiles(domains: string[]): HTMLElement {
  const list = node('ul', 'access-tiles');
  list.setAttribute('aria-label', 'Required access requested by the publisher');
  const labels = new Map([['gamepad', 'Gamepad'], ['inc', 'Napplet messages'], ['intent', 'Napplet actions']]);
  for (const domain of domains) {
    const tile = node('li', 'access-tile');
    tile.append(accessGlyph(domain), node('span', '', labels.get(domain) ?? accessCopy(domain).name));
    list.append(tile);
  }
  return list;
}

function publicationAccess(app: Publication): HTMLElement {
  const caps = detailSection('Access');
  const accessName = (name: string) => name === 'outbox' ? 'Nostr relays' : accessCopy(name).name;
  const requiredNames = [...new Set(app.required.map(accessName))];
  caps.append(node('p', 'access-summary', requiredNames.length ? `Uses ${accessList(requiredNames)}.` : 'No required access declared.'));
  if (app.required.length) caps.append(accessTiles(app.required));
  const accessDetails = node('details', 'access-details');
  const accessHeading = node('summary', '', 'Access details');
  accessHeading.append(glyph('down'));
  accessDetails.append(accessHeading);
  capabilities(accessDetails, 'Required', app.required);
  capabilities(accessDetails, 'Optional', app.optional);
  accessDetails.append(node('p', 'muted', 'These are publisher requests. Your shell decides which access is available.'));
  if (app.required.length || app.optional.length) caps.append(accessDetails);
  return caps;
}

type DetailOptions = {
  backToSearch: boolean;
  close(): void;
  open(feedback: HTMLElement): HTMLButtonElement;
  media: ViewMedia;
  revision: ReturnType<RevisionHistory['status']>;
  stale: boolean;
  profile?: Profile;
};

export function renderPublicationDetail(detail: HTMLElement, entry: CatalogEntry, options: DetailOptions): void {
  const {backToSearch, close, media, revision, stale, profile: publisherProfile} = options;
  const app = entry.publication;
  const header = node('header');
  const goBack = button(backToSearch ? 'Search results' : 'Discover', 'back', close);
  goBack.prepend(glyph('back'));
  goBack.setAttribute('aria-label', backToSearch ? 'Back to search results' : 'Back to Discover');
  const title = node('h1', 'app-name', app.title);
  title.id = 'detail-heading';
  title.tabIndex = -1;
  header.append(goBack);

  const identity = node('div', 'identity');
  const names = node('div');
  names.append(title);
  identity.append(artwork(app, media, true), names);

  const actions = node('div', 'detail-actions');
  const announcement = node('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-atomic', 'true');
  const feedback = node('div', 'feedback');
  feedback.hidden = true;
  announcement.append(feedback);
  const explanation = node('p', 'compat-detail');
  if (entry.conflict || revision === 'conflict') {
    explanation.textContent = 'This publisher signed different releases at the same timestamp. Opening is unavailable until the conflict is resolved.';
  } else if (revision === 'superseded') {
    explanation.textContent = 'A newer signed release is available. Return to Discover to view it.';
  } else if (stale) {
    explanation.textContent = 'Refresh the directory before opening a saved release.';
  } else if (canOpen()) {
    actions.append(options.open(feedback));
  } else {
    explanation.textContent = 'This shell does not offer link opening. Select the address in Publication details.';
  }
  explanation.hidden = !explanation.textContent;
  const preview = node('div', 'detail-art');
  screenshot(preview, app.screenshots, media);
  const about = node('div', 'detail-intro');
  about.append(node('p', 'description', app.description || 'The publisher did not provide a description.'));
  const timestamp = publicationTimestamp(app.signed.event.created_at);
  if (timestamp) {
    const updated = node('time', 'publication-date', `Updated ${timestamp.label}`);
    updated.dateTime = timestamp.iso;
    about.append(updated);
  }
  const recommendation = recommendControl(app);

  names.append(publisherDisclosure(app));
  const overview = node('div', 'detail-overview');
  overview.style.setProperty('--detail-tone', publicationColours(app)[0]);
  overview.append(preview, identity, about);

  const publication = node('details', 'publication');
  publication.id = 'publication-reference';
  const referenceTitle = node('summary', '', 'Publication details');
  referenceTitle.append(glyph('down'));
  publication.append(referenceTitle, reference('Publication address', app.address), reference('Signed event ID', app.signed.event.id), reference('Format', app.format), reference('Artifact hash', app.artifactHash));
  if (app.categories.length) publication.append(reference('Categories', app.categories.join(' · ')));
  const body = node('div', 'detail-body');
  body.append(header, overview, publicationAccess(app), explanation, publication);
  if (recommendation) body.append(recommendation);
  actions.prepend(announcement);
  detail.replaceChildren(body, actions);
  updatePublisher(app, publisherProfile);
}
