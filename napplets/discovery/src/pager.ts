import type { NostrFilter } from '@napplet/sdk';
import { KIND, parsePublication, revisionOrder, verifySignedEvent, type CatalogEntry, type Publication, type VerifiedEvent } from './catalog.ts';

export type Query = (filters: NostrFilter[], expiresAt?: number) => Promise<unknown>;
export type Preview = (filter: NostrFilter, receive: (row: unknown) => void) => {close(): void} | undefined;
export const PAGE_DEADLINE_MS = 5500;
class PageSizeError extends Error {}

function remaining(expiresAt: number): number {
  const ms = Math.ceil(expiresAt - performance.now());
  if (ms < 1) throw new Error('Page deadline reached');
  return ms;
}

async function beforeDeadline(query: Query, filter: NostrFilter, expiresAt: number) {
  const ms = remaining(expiresAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([query([filter], expiresAt), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Page deadline reached')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const PAGE_SIZE = 8;
const MAX_EVENTS = 250;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;

export function readVerifiedPage(result: unknown, filter: NostrFilter, now: number) {
  if (!Array.isArray(result)) throw new Error('Invalid query response');
  if (result.length > 32) throw new PageSizeError('Unbounded query response');
  const valid = new Map<string, VerifiedEvent>();
  let skipped = false;
  let bytes = 0;
  for (const row of result) {
    const event = verifySignedEvent(row?.event, filter, now);
    if (!event) {
      skipped = true;
      continue;
    }
    bytes += event.bytes;
    if (bytes > 512 * 1024) throw new PageSizeError('Unbounded query response');
    valid.set(event.event.id, event);
  }
  return { valid: [...valid.values()].sort((a, b) => revisionOrder(a.event, b.event)), skipped, received: result.length };
}

const MAX_KNOWN_COORDINATES = 1000;

export class RevisionHistory {
  private latest = new Map<string, { timestamp: number; id: string; conflict: boolean }>();

  private readonly onChange?: () => void;

  constructor(onChange?: () => void) { this.onChange = onChange; }

  status({address, signed: {event}}: Publication): 'current' | 'conflict' | 'superseded' {
    const last = this.latest.get(address);
    if (!last || event.created_at > last.timestamp) return 'current';
    if (event.created_at < last.timestamp) return 'superseded';
    return last.conflict || event.id !== last.id ? 'conflict' : 'current';
  }

  observe(publication: Publication): 'current' | 'conflict' | 'superseded' | 'bounded' {
    const {address, signed: {event}} = publication;
    const last = this.latest.get(address);
    if (!last && this.latest.size >= MAX_KNOWN_COORDINATES) return 'bounded';
    if (!last || event.created_at > last.timestamp) {
      this.latest.set(address, { timestamp: event.created_at, id: event.id, conflict: false });
      if (last) this.onChange?.();
      return 'current';
    }
    const status = this.status(publication);
    if (status === 'conflict' && !last.conflict) {
      last.conflict = true;
      this.onChange?.();
    }
    return status;
  }
}

export class CatalogPager {
  readonly until: number;
  private cursor: number;
  private requests = 0;
  private indexed = new Map<string, CatalogEntry>();
  private seen = new Set<string>();
  private bytes = 0;
  private nextLimit = PAGE_SIZE;
  private pending = false;
  private query: Query;
  private now: () => number;
  private history: RevisionHistory;
  private preview?: Preview;
  private previewIndex?: CatalogPager;
  checkedAt?: number;
  pagesChecked = 0;
  done = false;
  bounded = false;
  gap = false;
  skipped = false;
  reduced = false;
  private retryPage?: string;
  private missedPage = false;
  get partial(): boolean { return this.missedPage || this.retryPage !== undefined; }
  withheld = false;

  constructor(
    query: Query,
    now: () => number = () => Math.floor(Date.now() / 1000),
    history = new RevisionHistory(),
    preview?: Preview,
  ) {
    this.query = query;
    this.now = now;
    this.history = history;
    this.preview = preview;
    this.until = this.cursor = now();
  }

  get entries(): CatalogEntry[] {
    const visible = new Map(this.indexed);
    for (const [address, entry] of this.previewIndex?.indexed ?? []) {
      const current = visible.get(address);
      if (!current || revisionOrder(entry.publication.signed.event, current.publication.signed.event) < 0) visible.set(address, entry);
    }
    return [...visible.values()].flatMap(entry => {
      const status = this.history.status(entry.publication);
      if (status === 'superseded') return [];
      return [{publication: entry.publication, conflict: status === 'conflict'}];
    }).sort((a, b) => revisionOrder(a.publication.signed.event, b.publication.signed.event));
  }

  async more(progress?: () => void): Promise<void> {
    if (this.done || this.pending) return;
    this.pending = true;
    try {
      await this.readRelayPage(performance.now() + PAGE_DEADLINE_MS, progress);
      this.pagesChecked++;
      this.checkedAt = this.now();
    } finally {
      this.pending = false;
    }
  }

  private async readRelayPage(expiresAt: number, progress?: () => void): Promise<void> {
    const page = await this.readPage(expiresAt, progress);
    this.index(page.valid);
    if (page.retry) return;
    const oldest = page.valid[page.valid.length - 1]?.event.created_at;
    if (oldest === undefined || page.received < this.nextLimit) {
      this.done = true;
    } else if (oldest === this.cursor && !this.done) {
      await this.readBoundary(oldest, expiresAt);
    } else {
      this.cursor = oldest;
    }
  }

  private async readPage(expiresAt: number, progress?: () => void) {
    for (;;) {
      try {
        return await this.read({ kinds: [KIND], until: this.cursor, limit: this.nextLimit }, expiresAt, progress);
      } catch (error) {
        if (!(error instanceof PageSizeError) || this.nextLimit === 2) throw error;
        this.reduced = true;
        this.nextLimit /= 2;
      }
    }
  }

  private async readBoundary(timestamp: number, expiresAt: number): Promise<void> {
    if (this.requests >= MAX_PAGES) return;
    try {
      const boundary = await this.read({ kinds: [KIND], until: timestamp, since: timestamp, limit: 32 }, expiresAt);
      this.index(boundary.valid);
      if (boundary.retry) return;
      this.gap ||= boundary.received >= 32 || boundary.skipped;
    } catch {
      this.gap = true;
    }
    if (timestamp === 0) this.done = true;
    else this.cursor = timestamp - 1;
  }

  private async read(filter: NostrFilter, expiresAt: number, progress?: () => void) {
    remaining(expiresAt);
    const preview = new Map<string, VerifiedEvent>();
    let reads = 0, bytes = 0, closed = false;
    let subscription: ReturnType<Preview>;
    if (this.pagesChecked === 0 && progress && filter.since === undefined) {
      try {
        subscription = this.preview?.(filter, raw => {
          if (closed || performance.now() >= expiresAt || ++reads > 32 || preview.size >= this.nextLimit) return;
          const signed = verifySignedEvent((raw as {event?: unknown} | null)?.event, filter, this.now());
          if (!signed || preview.has(signed.event.id) || (bytes += signed.bytes) > 512 * 1024) return;
          preview.set(signed.event.id, signed);
          this.previewIndex ??= new CatalogPager(this.query, this.now, this.history);
          this.previewIndex.index([signed]);
          progress();
        });
      } catch { /* One-shot reads still cover the selected relays. */ }
    }
    let raw: unknown;
    try {
      raw = await beforeDeadline(this.query, filter, expiresAt);
    } catch (error) {
      if (!preview.size) throw error;
      raw = {events: [...preview.values()].map(({event}) => ({event})), incomplete: true};
    } finally {
      closed = true;
      this.previewIndex = undefined;
      try { subscription?.close(); } catch { /* Host teardown can already have closed it. */ }
    }
    let rows = raw;
    let incomplete = false;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (!('events' in raw) || ('error' in raw && raw.error) ||
          ('incomplete' in raw && raw.incomplete !== undefined && typeof raw.incomplete !== 'boolean')) {
        throw new Error('Invalid query response');
      }
      rows = raw.events;
      incomplete = 'incomplete' in raw && raw.incomplete === true;
    }
    const page = readVerifiedPage(rows, filter, this.now());
    this.skipped ||= page.skipped;
    if (page.received && !page.valid.length) throw new Error('No valid signed events in response');
    if (++this.requests >= MAX_PAGES) this.bounded = this.done = true;
    // Keep the window in place for one retry on the next Load more; a repeated
    // partial result can still supply useful rows and must not stall the feed.
    const key = [filter.until, filter.since, filter.limit].join('/');
    const retry = incomplete && !this.done && this.retryPage !== key;
    if (retry) this.retryPage = key;
    else if (this.retryPage === key) this.retryPage = undefined;
    if (incomplete && !retry) this.missedPage = true;
    return {...page, retry};
  }

  private index(events: VerifiedEvent[]): void {
    for (const verified of events) {
      if (this.seen.has(verified.event.id)) continue;
      if (this.seen.size >= MAX_EVENTS || this.bytes + verified.bytes > MAX_BYTES) {
        this.bounded = this.done = true;
        break;
      }
      this.seen.add(verified.event.id);
      this.bytes += verified.bytes;
      const publication = parsePublication(verified);
      if (!publication) continue;
      const known = this.history.observe(publication);
      if (known === 'bounded') {
        this.bounded = this.done = true;
        break;
      }
      if (known === 'superseded') {
        this.withheld ||= !this.indexed.has(publication.address);
        continue;
      }
      const current = this.indexed.get(publication.address);
      const previous = current?.publication.signed.event;
      if (!previous || verified.event.created_at > previous.created_at) {
        this.indexed.set(publication.address, { publication, conflict: known === 'conflict' });
      } else if (verified.event.created_at === previous.created_at) {
        this.indexed.set(publication.address, {
          publication: revisionOrder(verified.event, previous) < 0 ? publication : current!.publication,
          conflict: true,
        });
      }
    }
  }
}
