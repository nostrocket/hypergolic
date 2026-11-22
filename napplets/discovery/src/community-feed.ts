import type {Publication} from './catalog.ts';
import {createCommunityRecommendations, type CommunityRecommendation} from './community-recommendations.ts';
import {artwork, button, glyph, node} from './dom.ts';
import {ViewMedia} from './media.ts';
import type {Query, RevisionHistory} from './pager.ts';

/** Optional signed public samples stay quiet until they can appear without moving an active feed. */
export class CommunityFeed {
  private controller = new AbortController();
  private reader: ReturnType<typeof createCommunityRecommendations>;
  private media = new ViewMedia();
  private publications: readonly Publication[] = [];
  private items: readonly CommunityRecommendation[] = [];
  private index = 0;
  private request = 0;
  private allowed = true;
  private rendered = false;
  private dirty = false;
  private appButton?: HTMLButtonElement;
  private content = node('div', 'community-content');
  private position = node('span', 'community-position');
  private previous = button('', 'community-previous', () => this.move(-1));
  private next = button('', 'community-next', () => this.move(1));
  private resume = () => {if (window.scrollY < 8) this.render();};

  constructor(private element: HTMLElement, private query: Query,
    private select: (publication: Publication, control: HTMLElement) => void, private canPresent: () => boolean, private history: RevisionHistory) {
    this.reader = this.makeReader();
    const header = node('div', 'community-header'), navigation = node('div', 'community-navigation');
    header.append(node('h2', '', 'Recommended'));
    this.previous.setAttribute('aria-label', 'Previous recommendation');
    this.next.setAttribute('aria-label', 'Next recommendation');
    this.previous.append(glyph('back')); this.next.append(glyph('chevron'));
    this.position.setAttribute('role', 'status');
    this.position.setAttribute('aria-atomic', 'true');
    navigation.append(this.previous, this.position, this.next);
    header.append(navigation);
    const scope = node('p', 'sr-only', 'A sample from signed public lists');
    scope.id = 'community-scope'; element.setAttribute('aria-describedby', scope.id);
    element.append(header, this.content, scope);
    window.addEventListener('scroll', this.resume, {passive: true});
  }

  async update(publications: readonly Publication[]): Promise<void> {
    this.publications = publications;
    const request = ++this.request;
    const result = await this.reader.read(publications);
    if (request !== this.request || this.controller.signal.aborted) return;
    const current = this.items[this.index];
    this.items = result.items;
    const retained = current ? this.items.findIndex(item => item.publication.address === current.publication.address &&
      item.recommender.pubkey === current.recommender.pubkey) : -1;
    this.index = Math.max(0, retained);
    this.dirty = true;
    this.render();
  }

  setVisible(allowed: boolean): void {
    this.allowed = allowed;
    this.element.hidden = !allowed || !this.rendered;
    this.render();
  }

  reset(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.reader = this.makeReader();
    this.request++;
    this.items = []; this.index = 0; this.dirty = false; this.rendered = false;
    this.element.hidden = true;
    this.content.replaceChildren();
    this.media.close(); this.media = new ViewMedia();
    this.appButton = undefined;
  }

  returnTarget(address: string): HTMLElement | undefined {
    return this.appButton?.dataset.communityApp === address ? this.appButton : undefined;
  }

  close(): void {
    this.controller.abort(); this.request++;
    this.media.close();
    window.removeEventListener('scroll', this.resume);
  }

  private move(delta: number): void {
    const index = this.index + delta;
    if (index < 0 || index >= this.items.length) return;
    this.index = index; this.dirty = true;
    this.render(true);
  }

  present(): void {this.render();}

  private makeReader() {
    const controller = this.controller;
    return createCommunityRecommendations(this.query, controller.signal, () => {
      if (this.controller === controller && !controller.signal.aborted) void this.update(this.publications);
    }, this.history);
  }

  private render(explicit = false): void {
    if (!this.dirty || !this.allowed || !explicit && !this.canPresent()) return;
    this.dirty = false;
    const item = this.items[this.index];
    this.rendered = Boolean(item);
    this.element.hidden = !item;
    if (!item) {this.content.replaceChildren(); return;}
    this.media.clearTargets();
    const app = item.publication;
    const target = button('', 'community-app', () => this.select(app, target));
    target.dataset.communityApp = app.address;
    target.setAttribute('aria-label', `Details for ${app.title} recommended by ${item.recommender.label}`);
    const copy = node('span', 'community-copy');
    copy.append(node('strong', 'community-title', app.title), node('span', 'community-description', app.description));
    target.append(artwork(app, this.media), copy);
    this.content.replaceChildren(target, node('p', 'community-attribution', `Recommended by ${item.recommender.label}`));
    this.appButton = target;
    this.previous.disabled = this.index === 0;
    this.next.disabled = this.index === this.items.length - 1;
    this.position.textContent = `${this.index + 1} / ${this.items.length}`;
    this.position.setAttribute('aria-label', `Recommendation ${this.index + 1} of ${this.items.length}`);
  }
}
