import type { NostrFilter } from '@napplet/sdk';
import { KIND, parseProfile, parsePublication, revisionOrder, validIdentifier, verifySignedEvent, type Publication, type VerifiedEvent } from './catalog.ts';
import { readVerifiedPage, RevisionHistory, type Query } from './pager.ts';

export type CommunityRecommendation = Readonly<{
  publication: Publication;
  recommender: Readonly<{ pubkey: string; label: string }>;
  eventId: string;
  createdAt: number;
}>;
export type CommunityRecommendations = Readonly<{ items: readonly CommunityRecommendation[]; partial: boolean }>;
const LIST_BUDGET_MS = 18_000;
const PROFILE_BUDGET_MS = 18_000;
const FILTERS_PER_QUERY = 4;
const MAX_LOOKUPS = 2 * FILTERS_PER_QUERY;
const LIST_FILTER = { kinds: [30267], '#d': ['napplets'], limit: 32 };
type Sample = {now: number; lists?: Promise<readonly VerifiedEvent[]>; transport?: Promise<unknown>; labels: Map<string, Promise<string | undefined>>;
  names: Map<string,string>; apps: Map<string, Publication | undefined>; resolved: Map<string, Publication>;
  lookup?: Promise<void>; history: RevisionHistory; onChange?: () => void};
type ReadContext = {now: number; deadline: number; signal?: AbortSignal};
class CommunitySampleTimeout extends Error {}

/** Optional public sample, never a follow graph or a complete recommendation index.
 * One sample reads at most 32 lists from the shell's Network relays, then at
 * most 32 kind-0 revisions for up to eight matching authors. Up to eight unique
 * app/author pairs follow newest-list ordering, then the signed reference order.
 * Only the newest observed signed list per author contributes; an empty or malformed replacement withdraws
 * that author's older entries. For up to eight missing coordinates we request
 * the exact publisher and identifier through the shell's ordinary Relay grant.
 * Only publisher-signed, verified manifests can fill a recommendation. SDK relay.query has no completeness
 * receipt, so partial stays true, including empty results. Create a new sampler
 * on explicit refresh; paging rematches the same sample and reads profiles only
 * for newly matched authors. Lists have an eighteen-second budget to accommodate
 * the host's fifteen-second read. Factory reads expose short keys immediately,
 * then notify once a background profile batch supplies verified names (also
 * bounded to eighteen seconds). These budgets fence late replies; they cannot
 * cancel an already-dispatched host read. A settled non-timeout SDK rejection
 * gets one retry within the same budget. Empty successes remain cached; rejected
 * samples clear, while an in-flight transport is reused after a guest deadline.
 * No identity, follows, signing or write is used. */
export async function loadCommunityRecommendations(publications: readonly Publication[], query: Query, signal?: AbortSignal): Promise<CommunityRecommendations> {
  const sample = newSample();
  const initial = await readRecommendations(publications, query, sample, signal);
  if (!initial.items.length) return initial;
  await Promise.all(sample.labels.values());
  return readRecommendations(publications, query, sample, signal);
}

const newSample = (history = new RevisionHistory()): Sample => ({now: Math.floor(Date.now() / 1000),
  labels: new Map(), names: new Map(), apps: new Map(), resolved: new Map(), history});
export function createCommunityRecommendations(query: Query, signal?: AbortSignal, onChange?: () => void, history?: RevisionHistory) {
  const sample = newSample(history);
  sample.onChange = onChange;
  return Object.freeze({read: (publications: readonly Publication[]) => readRecommendations(publications, query, sample, signal)});
}

async function readRecommendations(publications: readonly Publication[], query: Query, sample: Sample, signal?: AbortSignal): Promise<CommunityRecommendations> {
  const {now} = sample, deadline = performance.now() + LIST_BUDGET_MS;
  const empty = () => Object.freeze({ items: Object.freeze([]), partial: true });
  if (signal?.aborted) return empty();
  try {
    if (!sample.lists) {
      const pending = readListSample(query, sample, {now, deadline, signal});
      sample.lists = pending;
      void pending.catch(() => {if (sample.lists === pending) sample.lists = undefined;});
    }
    const lists = await sample.lists;
    const missing = new Map<string, NostrFilter>();
    let candidates = matchedRecommendations(lists, publications, sample, missing);
    if (!sample.lookup && missing.size && !signal?.aborted) {
      sample.lookup = resolveMissing(missing, query, sample, signal);
    }
    if (sample.lookup && (!candidates.length || !sample.onChange)) {
      await sample.lookup;
      candidates = matchedRecommendations(lists, publications, sample);
    }
    if (!candidates.length || signal?.aborted) return empty();
    startLabels([...new Set(candidates.map(candidate => candidate.author))], query, sample,
      { now, deadline: performance.now() + PROFILE_BUDGET_MS, signal });
    if (signal?.aborted) return empty();
    const items = candidates.map(candidate => Object.freeze({ publication: candidate.publication,
      recommender: Object.freeze({ pubkey: candidate.author, label: sample.names.get(candidate.author) ?? shortKey(candidate.author) }),
      eventId: candidate.signed.event.id, createdAt: candidate.signed.event.created_at }));
    return Object.freeze({ items: Object.freeze(items), partial: true });
  } catch {
    return empty();
  }
}

async function readListSample(query: Query, sample: Sample, context: ReadContext): Promise<readonly VerifiedEvent[]> {
  const filter = {...LIST_FILTER, until: context.now};
  const shared: Query = filters => {
    if (!sample.transport) {
      const pending = query(filters);
      sample.transport = pending;
      void pending.catch(() => {if (sample.transport === pending) sample.transport = undefined;});
    }
    return sample.transport;
  };
  let response: unknown;
  try {response = await boundedQuery(shared, [filter], context.deadline, context.signal);}
  catch (error) {
    // A guest timer does not cancel the dispatched SDK operation. Keep that
    // promise and reuse it; only a settled non-timeout SDK rejection can retry.
    if (context.signal?.aborted || error instanceof CommunitySampleTimeout ||
        error instanceof Error && /timed? out|timeout/iu.test(error.message)) throw error;
    response = await boundedQuery(shared, [filter], context.deadline, context.signal);
  }
  return newestLists(readVerifiedPage(response, filter, context.now).valid);
}

function newestLists(events: readonly VerifiedEvent[]): readonly VerifiedEvent[] {
  const latest = new Map<string, VerifiedEvent>();
  for (const signed of events) {
    // A malformed latest list containing this identifier must not revive an
    // older endorsement by being discarded before revision selection.
    if (!signed.event.tags.some(tag => tag[0] === 'd' && tag[1] === 'napplets')) continue;
    const prior = latest.get(signed.event.pubkey);
    if (!prior || revisionOrder(signed.event, prior.event) < 0) latest.set(signed.event.pubkey, signed);
  }
  return [...latest.values()].sort((a, b) => revisionOrder(a.event, b.event));
}

function verifiedLoaded(source: Publication, sample: Sample): Publication | undefined {
  const id = source.signed.event.id;
  if (!sample.apps.has(id) && sample.apps.size < 250) {
    const event = verifySignedEvent(source.signed.event, {kinds: [KIND], until: sample.now}, sample.now);
    sample.apps.set(id, event && parsePublication(event));
  }
  const app = sample.apps.get(id);
  if (app && app.address === source.address && app.publisher === source.publisher &&
      app.identifier === source.identifier && sample.history.observe(app) === 'current') return app;
}

function matchedRecommendations(lists: readonly VerifiedEvent[], publications: readonly Publication[], sample: Sample, missing?: Map<string, NostrFilter>) {
  const matches: {signed: VerifiedEvent; publication: Publication; author: string}[] = [];
  const loaded = new Map(publications.slice(0,250).map(app => [`${KIND}:${app.publisher}:${app.identifier}`,app]));
  const checked = new Map<string, Publication | undefined>();
  for (const signed of lists) {
    const identifiers = signed.event.tags.filter(tag => tag[0] === 'd');
    if (identifiers.length !== 1 || identifiers[0]!.length !== 2) continue;
    const seen = new Set<string>();
    for (const tag of signed.event.tags) {
      if (tag[0] !== 'a' || !tag[1] || seen.has(tag[1])) continue;
      seen.add(tag[1]);
      const source = loaded.get(tag[1]);
      const cached = sample.resolved.get(tag[1]);
      if (!source && !cached) {
        if (!sample.lookup && missing && missing.size < MAX_LOOKUPS && !missing.has(tag[1])) {
          const filter = exactFilter(tag[1], sample.now);
          if (filter) missing.set(tag[1], filter);
        }
        continue;
      }
      if (!checked.has(tag[1]) && checked.size < 16) {
        const publication = (source && verifiedLoaded(source, sample)) ?? cached;
        checked.set(tag[1], publication && sample.history.status(publication) === 'current' ? publication : undefined);
      }
      const publication = checked.get(tag[1]);
      if (publication) matches.push({ signed, publication, author: signed.event.pubkey });
      if (matches.length === 8) return matches;
    }
  }
  return matches;
}

function exactFilter(coordinate: string, until: number): NostrFilter | undefined {
  const match = /^35129:([0-9a-f]{64}):([\s\S]+)$/u.exec(coordinate);
  if (!match || !validIdentifier(match[2]!)) return;
  return {kinds: [KIND], authors: [match[1]!], '#d': [match[2]!], until, limit: 2};
}

async function resolveMissing(missing: Map<string, NostrFilter>, query: Query, sample: Sample, signal?: AbortSignal): Promise<void> {
  const entries = [...missing];
  const deadline = performance.now() + LIST_BUDGET_MS;
  async function readBatch(batch: Map<string, NostrFilter>): Promise<void> {
    try {
      const rows = await boundedQuery(query, [...batch.values()], deadline, signal);
      if (signal?.aborted) return;
      const page = readVerifiedPage(rows, {kinds: [KIND], until: sample.now}, sample.now);
      for (const signed of page.valid) {
        const app = parsePublication(signed);
        if (!app) continue;
        const coordinate = `${KIND}:${app.publisher}:${app.identifier}`;
        if (!batch.has(coordinate)) continue;
        const revision = sample.history.observe(app);
        if (revision === 'current') sample.resolved.set(coordinate, app);
        if (revision === 'conflict') sample.resolved.delete(coordinate);
      }
      if (sample.resolved.size) sample.onChange?.();
    } catch {
      // An unavailable batch must not remove a verified recommendation.
    }
  }
  // Keep a host read slot free for foreground paging. Deliver the first picks
  // before spending the remaining deadline on a second batch.
  await readBatch(new Map(entries.slice(0, FILTERS_PER_QUERY)));
  if (entries.length > FILTERS_PER_QUERY && !signal?.aborted && performance.now() < deadline) {
    await readBatch(new Map(entries.slice(FILTERS_PER_QUERY)));
  }
}

const shortKey = (pubkey: string) => `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
function startLabels(authors: readonly string[], query: Query, sample: Sample, context: ReadContext): void {
  const missing = authors.filter(author => !sample.labels.has(author));
  if (missing.length) {
    const pending = recommenderLabels(missing, query, context).then(labels => {
      if (context.signal?.aborted) return new Map<string,string>();
      let changed = false;
      for (const [author,label] of labels) {
        if (sample.names.get(author) !== label) {sample.names.set(author,label); changed = true;}
      }
      if (changed) sample.onChange?.();
      return labels;
    }).catch(() => new Map<string,string>());
    for (const author of missing) sample.labels.set(author, pending.then(labels => labels.get(author)));
  }
}
async function recommenderLabels(authors: readonly string[], query: Query, context: ReadContext): Promise<ReadonlyMap<string,string>> {
  const labels = new Map<string,string>();
  try {
    const filter = { kinds: [0], authors: [...authors], until: context.now, limit: 32 };
    const response = await boundedQuery(query, [filter], context.deadline, context.signal);
    const seen = new Set<string>();
    for (const signed of readVerifiedPage(response, filter, context.now).valid) {
      const author = signed.event.pubkey;
      if (seen.has(author)) continue;
      seen.add(author);
      const name = parseProfile(signed)?.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80);
      if (name) labels.set(author,name);
    }
  } catch {
    // Optional profile failure leaves the signed recommender key visible.
  }
  return labels;
}

async function boundedQuery(query: Query, filters: NostrFilter[], deadline: number, signal?: AbortSignal): Promise<unknown> {
  const remaining = Math.floor(deadline - performance.now());
  if (signal?.aborted || remaining < 1) throw Error('Community sample cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Error('Community sample cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new CommunitySampleTimeout('Community sample timed out')), remaining);
  });
  try {
    const result = await Promise.race([query(filters), stopped]);
    if (signal?.aborted) throw Error('Community sample cancelled');
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
