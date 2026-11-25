import {accessCopy} from './access-copy.ts';
import type {CatalogEntry, Profile, Publication} from './catalog.ts';
import {accessGlyph, artwork, button, find, glyph, node, screenshot} from './dom.ts';
import {canOpen} from './host.ts';
import type {ViewMedia} from './media.ts';
import type {RevisionHistory} from './pager.ts';
import {publicationTimestamp} from './publication-date.ts';
import {recommendControl} from './recommendations.ts';

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

function requiredAccessSummary(domains: string[]): HTMLElement {
  const list = node('ul', 'required-access');
  list.setAttribute('aria-label', 'Required access requested by the publisher');
  const labels = new Map([['gamepad', 'Gamepad'], ['inc', 'Napplet messages'], ['intent', 'Napplet actions']]);
  for (const domain of domains) {
    const tile = node('li', 'required-domain');
    tile.textContent = labels.get(domain) ?? accessCopy(domain).name;
    list.append(tile);
  }
  return list;
}

function publicationAccess(app: Publication): HTMLElement {
  const section = node('section', 'detail-section');
  const heading = node('h2', '', 'Access');
  heading.prepend(glyph('key'));
  if (app.required.length || app.optional.length) {
    const details = node('details', 'access-details');
    const summary = node('summary');
    summary.setAttribute('aria-label', 'Access details');
    summary.append(heading, glyph('down'));
    details.append(summary);
    capabilities(details, 'Required', app.required);
    capabilities(details, 'Optional', app.optional);
    details.append(node('p', 'muted', 'These are publisher requests. Your shell decides which access is available.'));
    section.append(details);
  } else {
    section.append(heading);
  }
  section.append(app.required.length
    ? requiredAccessSummary(app.required)
    : node('p', 'access-summary', 'No required access declared.'));
  return section;
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
  identity.append(artwork(app, media, identity), title);

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
  const lead = node('p', 'description detail-intro', app.description || 'The publisher did not provide a description.');
  const byline = node('div', 'publication-byline');
  byline.append(publisherDisclosure(app));
  const timestamp = publicationTimestamp(app.signed.event.created_at);
  if (timestamp) {
    const updated = node('time', 'publication-date', `Updated ${timestamp.label}`);
    updated.dateTime = timestamp.iso;
    byline.append(updated);
  }
  const recommendation = recommendControl(app);

  const overview = node('div', 'detail-overview');
  const launchCover = find<HTMLTemplateElement>('launch-cover-template').content.cloneNode(true);
  overview.append(preview, launchCover, identity, lead);

  const publication = node('details', 'publication');
  publication.id = 'publication-reference';
  const referenceTitle = node('summary', '', 'Publication details');
  referenceTitle.append(glyph('down'));
  publication.append(referenceTitle, reference('Publication address', app.address), reference('Signed event ID', app.signed.event.id), reference('Format', app.format), reference('Artifact hash', app.artifactHash));
  if (app.categories.length) publication.append(reference('Categories', app.categories.join(' · ')));
  const more = node('div', 'publication-links');
  more.append(publication);
  if (recommendation) more.append(recommendation);
  const secondary = node('div', 'publication-secondary');
  secondary.append(byline, more);
  const body = node('div', 'detail-body');
  body.append(header, overview, publicationAccess(app), explanation, secondary);
  actions.prepend(announcement);
  detail.replaceChildren(body, actions);
  updatePublisher(app, publisherProfile);
}
