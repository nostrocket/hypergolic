import './compat.ts';
import {CommunityFeed} from './community-feed.ts';
import { matchesSearch, parseProfile, verifySignedEvent, type CatalogEntry, type Category, type Profile } from './catalog.ts';
import { button, find, glyph, node } from './dom.ts';
import { canRead, canOpen, connectTheme, openPublication, query, queryCatalog, previewCatalog, ready } from './host.ts';
import { ViewMedia } from './media.ts';
import { CatalogPager, RevisionHistory } from './pager.ts';
import {publicationAge, publicationRow, updateRowPublishers} from './publication-row.ts';
import {renderPublicationDetail, updatePublisher} from './publication-detail.ts';

const template = find<HTMLTemplateElement>('directory-template');
find('catalog').replaceChildren(template.content);
template.remove();

const listing = find('listing'), detail = find('detail'), heading = find('heading');
const search = find<HTMLInputElement>('query'), back = find<HTMLButtonElement>('search-back');
const clear = find<HTMLButtonElement>('clear');
const browseControls = find('browse-controls'), feedHeading = find('feed-heading');
const results = find<HTMLOListElement>('results'), more = find<HTMLButtonElement>('more');
const refresh = find<HTMLButtonElement>('refresh'), scope = find('scope');
const notice = find('notice'), empty = find('empty'), coverage = find('coverage');
const rowOpenStatus = find('row-open-status');
const rowOpenAnnouncement = find('row-open-announcement');
const openingStatus = find('opening-status');
const categories: ('All' | Category)[] = ['All', 'Games', 'Tools', 'Creative'];
const profiles = new Map<string, Profile>();
const attemptedProfiles = new Set<string>();
let revisionUpdatePending = false;
const history = new RevisionHistory(() => {
  if (revisionUpdatePending) return;
  revisionUpdatePending = true;
  queueMicrotask(() => {
    revisionUpdatePending = false;
    if (selected && history.status(selected.publication) !== 'current') renderDetail();
    if (visibleEntries.some(entry => !entry.conflict && history.status(entry.publication) !== 'current')) renderList();
  });
});
let selectedCategory: (typeof categories)[number] = 'All';
let homeFilters: { category: 'All' | Category; scroll: number } | undefined;
let selected: CatalogEntry | undefined;
let detailBack: { scroll: number; focus: HTMLElement } | undefined;
let pager: CatalogPager | undefined;
let retryReset: CatalogPager | undefined;
let listMedia = new ViewMedia(), detailMedia = new ViewMedia();
let loading = true, relayAccess = false, readFailed = false, stale = false, profilePending = false;
let openPending: string | undefined;
let rowFeedbackContext = 0;
let rowFeedbackVersion: string | undefined;
let visibleEntries: CatalogEntry[] = [];
let restoringFeed = false;
const community = new CommunityFeed(find('community-recommendation'), query, (publication, control) => {
  const entry = pager?.entries.find(item => item.publication.address === publication.address);
  const revision = history.status(publication);
  if (revision === 'superseded' && entry) showDetail(entry, control);
  if (revision === 'current' || revision === 'conflict') showDetail({publication, conflict: revision === 'conflict'}, control);
}, () => !restoringFeed && !selected && !homeFilters && window.scrollY < 8 &&
  !results.contains(document.activeElement) && !find('community-recommendation').contains(document.activeElement), history);
window.addEventListener('pagehide', event => {if (!event.persisted) community.close();});

back.prepend(glyph('back'));
clear.append(glyph('close'));
find('search-icon').append(glyph('search'));
for (const category of categories) {
  const control = button(category, 'category', () => { selectedCategory = category; updateResults(); });
  control.dataset.category = category;
  find('categories').append(control);
}

function focus(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

function enterSearch(): void {
  if (homeFilters) return;
  homeFilters = { category: selectedCategory, scroll: window.scrollY };
  heading.textContent = 'Search results';
  find('eyebrow').textContent = 'Search results';
  back.hidden = false;
  listing.classList.add('search-mode');
}

function leaveSearch(): void {
  if (!homeFilters) return;
  clearRowFeedback();
  const previous = homeFilters;
  homeFilters = undefined;
  selectedCategory = previous.category;
  search.value = '';
  heading.textContent = 'Discover';
  find('eyebrow').textContent = 'Napplet directory';
  back.hidden = true;
  listing.classList.remove('search-mode');
  restoringFeed = true;
  renderList();
  window.scrollTo(0, previous.scroll);
  focus(search);
  restoringFeed = false;
  community.present();
}

function clearRowFeedback(): void {
  rowFeedbackContext += 1;
  rowFeedbackVersion = undefined;
  rowOpenStatus.replaceChildren();
  rowOpenStatus.hidden = true;
}

function placeRowFeedback(): void {
  const control = rowFeedbackVersion ? results.querySelector(`[data-open-version="${rowFeedbackVersion}"]`) : null;
  const row = control?.closest('.row');
  if (row) row.append(rowOpenAnnouncement);
  else results.before(rowOpenAnnouncement);
}

function updateResults(): void {
  clearRowFeedback();
  renderList();
  const headingTop = feedHeading.getBoundingClientRect().top;
  const controlsBottom = browseControls.getBoundingClientRect().bottom;
  if (headingTop < controlsBottom) window.scrollBy(0, headingTop - controlsBottom);
}

search.addEventListener('input', () => { if (search.value.trim()) enterSearch(); updateResults(); });
clear.addEventListener('click', () => { search.value = ''; updateResults(); focus(search); });
back.addEventListener('click', leaveSearch);
find('search-form').addEventListener('submit', event => {
  event.preventDefault();
  enterSearch();
  updateResults();
  focus(feedHeading);
});
more.addEventListener('click', () => { clearRowFeedback(); void load(false); });
refresh.addEventListener('click', () => { clearRowFeedback(); void load(true); });

function renderList(): void {
  const active = document.activeElement as HTMLElement | null;
  const prior = active?.dataset.row ?? active?.dataset.open;
  const wasOpen = Boolean(active?.dataset.open);
  const needle = search.value.trim();
  for (const tab of find('categories').querySelectorAll('button')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.category === selectedCategory));
  }
  clear.hidden = !search.value;
  feedHeading.textContent = homeFilters ? needle ? `Results for “${needle}”` : 'Search results' : 'Recently published';
  scope.hidden = !homeFilters;
  scope.textContent = 'Search covers loaded publications and fetched publisher profiles.';
  visibleEntries = (pager?.entries ?? []).filter(({ publication }) =>
    (selectedCategory === 'All' || publication.categories.includes(selectedCategory)) &&
    matchesSearch(publication, needle, profiles.get(publication.publisher)));
  listMedia.clearTargets();
  results.replaceChildren(...visibleEntries.map(entry => publicationRow(entry, listMedia, profiles, showDetail,
    canOpen() && !entry.conflict && !stale ? openButton(entry, 'row', rowOpenStatus) : undefined)));
  placeRowFeedback();
  if (prior && !listing.hidden) {
    const controls = results.querySelectorAll<HTMLButtonElement>(wasOpen ? '[data-open]' : '[data-row]');
    const replacement = [...controls].find(control => (wasOpen ? control.dataset.open : control.dataset.row) === prior);
    if (replacement) focus(replacement);
    else focus(feedHeading);
  }
  const count = visibleEntries.length;
  const resultStatus = find('result-status');
  const resultMessage = `${count} matching publication${count === 1 ? '' : 's'} in loaded results.`;
  if (!loading && resultStatus.textContent !== resultMessage) resultStatus.textContent = resultMessage;
  notice.textContent = loading ? pager?.entries.length ? 'Checking the relays…' : 'Reading signed publications…'
    : !relayAccess ? 'Directory access is unavailable. This Napplet needs relay access from the shell.'
    : readFailed ? stale ? 'Showing saved results from this session. Last checked ' + publicationAge(pager!.checkedAt!) + '. Check your relay settings and retry.'
      : pager ? 'Could not load older publications. Your loaded results are still available.'
        : 'The relays did not return a usable response. Check your connection or relay settings, then retry.'
    : pager?.partial ? pager.done
      ? 'Some relay results were unavailable. Refresh to check again.'
      : 'Some relay results were unavailable. Load more to continue.'
    : pager?.gap ? 'Some publications share a timestamp. Relay limits left a gap in the results.'
      : pager?.withheld ? 'Some relays returned older versions of releases seen in this session.'
        : pager?.skipped || pager?.reduced ? 'Relay limits or validation may have left out some publications.' : '';
  notice.hidden = !notice.textContent;
  empty.hidden = !relayAccess || loading || (readFailed && !pager) || Boolean(count);
  empty.replaceChildren();
  if (!empty.hidden) {
    if (needle || selectedCategory !== 'All') {
      empty.append(node('p', '', 'No matches in the loaded results.'),
        button('Clear filters', 'secondary', () => {
          search.value = '';
          selectedCategory = 'All';
          updateResults();
          focus(search);
        }));
    } else {
      empty.append(node('p', '', pager?.done ? 'Reachable relays returned no eligible named Napplets. Refresh to check again.' : 'No eligible Napplets have arrived for this page.'));
    }
  }
  more.hidden = !pager || pager.done || stale;
  more.setAttribute('aria-disabled', String(loading));
  more.textContent = readFailed && !stale ? 'Retry older publications' : 'Load more';
  refresh.hidden = !relayAccess || !pager && !readFailed;
  refresh.setAttribute('aria-disabled', String(loading));
  refresh.textContent = readFailed && (!pager || stale) ? 'Retry' : 'Refresh';
  coverage.hidden = !pager;
  coverage.textContent = pager
    ? `${pager.entries.length} verified publication${pager.entries.length === 1 ? '' : 's'} · Reachable relays · ${pager.pagesChecked} page${pager.pagesChecked === 1 ? '' : 's'} checked${pager.bounded ? ' · Directory limit reached' : ''}`
    : '';
  community.setVisible(!homeFilters && selectedCategory === 'All');
  void enrich();
}

async function load(reset: boolean): Promise<void> {
  if (loading || !canRead()) return;
  if (reset) community.reset();
  const next = reset || !pager ? retryReset ?? new CatalogPager(queryCatalog, undefined, history, previewCatalog) : pager;
  loading = true;
  readFailed = false;
  renderList();
  try {
    await next.more(() => {
      if (next.entries.length && !pager?.entries.length) pager = next;
      if (pager === next && !selected) renderList();
    });
    if (next.partial && !next.entries.length && pager?.entries.length && pager !== next) {
      retryReset = next;
      readFailed = stale = true;
    } else {
      pager = next;
      retryReset = undefined;
      stale = false;
    }
  } catch {
    readFailed = true;
    if (reset || !pager) retryReset = retryReset === next ? undefined : next;
    if (reset && pager?.entries.length) stale = true;
  } finally {
    loading = false;
    renderList();
    if (!readFailed && pager) void community.update(pager.entries.map(entry => entry.publication));
  }
}

async function enrich(): Promise<void> {
  if (!relayAccess || loading || profilePending || attemptedProfiles.size >= 48) return;
  const candidates = [
    ...(selected ? [selected] : []),
    ...visibleEntries.slice(0, 12),
    ...(homeFilters && search.value.trim() ? pager?.entries.slice(0, 24) ?? [] : []),
  ].map(({ publication }) => publication.publisher);
  const authors = [...new Set(candidates)].filter(author => !attemptedProfiles.has(author)).slice(0, Math.min(4, 48 - attemptedProfiles.size));
  if (!authors.length) return;
  authors.forEach(author => attemptedProfiles.add(author));
  profilePending = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const response = await query(authors.map(author => ({ kinds: [0], authors: [author], until: now, limit: 2 })));
    if (!Array.isArray(response) || response.length > 32) return;
    let changed = false;
    for (const row of response) {
      const verified = verifySignedEvent(row?.event, { kinds: [0], authors, until: now }, now);
      if (!verified) continue;
      const profile = parseProfile(verified);
      if (!profile) continue;
      const author = verified.event.pubkey;
      const current = profiles.get(author);
      if (!current || current.timestamp < profile.timestamp ||
        (current.timestamp === profile.timestamp && profile.eventId < current.eventId)) {
        profiles.set(author, profile);
        changed = true;
      }
    }
    if (changed) {
      if (selected) updatePublisher(selected.publication, profiles.get(selected.publication.publisher));
      updateRowPublishers(results, visibleEntries, profiles);
      if (homeFilters && search.value.trim()) renderList();
    }
  } catch {
    // Missing or unavailable profile data does not obscure the signing key.
  } finally {
    profilePending = false;
    if (!loading) queueMicrotask(() => void enrich());
  }
}

function showDetail(entry: CatalogEntry, returnFocus: HTMLElement): void {
  if (openPending) return;
  clearRowFeedback();
  detailBack = { scroll: window.scrollY, focus: returnFocus };
  selected = entry;
  listing.hidden = true;
  detail.hidden = false;
  listMedia.close();
  listMedia = new ViewMedia();
  renderDetail();
  window.scrollTo(0, 0);
  focus(find('detail-heading'));
  void enrich();
}

function closeDetail(): void {
  if (!detailBack || openPending) return;
  const previous = detailBack;
  selected = detailBack = undefined;
  detailMedia.close();
  detailMedia = new ViewMedia();
  detail.replaceChildren();
  detail.hidden = true;
  listing.hidden = false;
  const returnKey = previous.focus.dataset.row;
  const returnCommunity = previous.focus.dataset.communityApp;
  restoringFeed = true;
  renderList();
  window.scrollTo(0, previous.scroll);
  const restored = [...results.querySelectorAll<HTMLElement>('[data-row]')].find(control => control.dataset.row === returnKey);
  focus((returnCommunity ? community.returnTarget(returnCommunity) : restored) ?? heading);
  restoringFeed = false;
}

function renderDetail(): void {
  if (!selected) return;
  const entry = selected;
  renderPublicationDetail(detail, entry, {backToSearch: Boolean(homeFilters), close: closeDetail, media: detailMedia,
    open: feedback => openButton(entry, 'detail', feedback), revision: history.status(entry.publication),
    stale, profile: profiles.get(entry.publication.publisher)});
}

function openButton(entry: CatalogEntry, placement: 'row' | 'detail', feedback: HTMLElement): HTMLButtonElement {
  const control = button('', `primary ${placement}-open open-action`, event =>
    void requestOpen(entry, event.currentTarget as HTMLButtonElement, feedback));
  control.dataset.openVersion = entry.publication.signed.event.id;
  control.dataset.openTitle = entry.publication.title;
  control.dataset.openLabel = placement === 'row' ? 'Open ' + entry.publication.title : 'Open Napplet';
  const spinner = node('span', 'open-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  control.append(spinner, node('span', 'open-label'));
  updateOpenControl(control);
  return control;
}

function updateOpenControl(control: HTMLButtonElement): void {
  const pending = openPending === control.dataset.openVersion;
  control.toggleAttribute('data-opening', pending);
  if (pending) control.setAttribute('aria-busy', 'true');
  else control.removeAttribute('aria-busy');
  if (openPending) control.setAttribute('aria-disabled', 'true');
  else control.removeAttribute('aria-disabled');
  control.setAttribute('aria-label', pending ? `Opening ${control.dataset.openTitle}…` : control.dataset.openLabel!);
  control.querySelector('.open-label')!.textContent = pending ? 'Opening…' : 'Open';
}

function updateOpenControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-open-version]').forEach(updateOpenControl);
}

async function requestOpen(entry: CatalogEntry, control: HTMLButtonElement, feedback: HTMLElement): Promise<void> {
  if (openPending || entry.conflict || history.status(entry.publication) !== 'current' || stale || !canOpen()) return;
  openPending = entry.publication.signed.event.id;
  const context = feedback === rowOpenStatus ? rowFeedbackContext : undefined;
  if (context !== undefined) {
    rowFeedbackVersion = openPending;
    placeRowFeedback();
  }
  feedback.hidden = true;
  feedback.replaceChildren();
  focus(control);
  updateOpenControls();
  openingStatus.textContent = `Opening ${entry.publication.title}…`;
  try {
    const message = await openPublication(entry.publication);
    if (context === undefined || context === rowFeedbackContext) {
      feedback.textContent = message;
      feedback.hidden = false;
    }
  } finally {
    openPending = undefined;
    openingStatus.textContent = '';
    updateOpenControls();
  }
}

window.addEventListener('pagehide', event => {
  if (!event.persisted) {
    listMedia.close();
    detailMedia.close();
  }
});

void connectTheme();
void ready().then(available => {
  relayAccess = available;
  loading = false;
  if (available) void load(true);
  else renderList();
});
