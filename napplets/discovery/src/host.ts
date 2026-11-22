import { linkOpen, outboxQuery, relay, type NostrFilter, themeGet, themeOnChanged, type Theme } from '@napplet/sdk';
import type { Publication } from './catalog.ts';
import { PAGE_DEADLINE_MS, type Preview } from './pager.ts';

const surface = window as Window & {
  napplet?: {
    shell?: { ready(): Promise<void> };
    relay?: {subscribe?: unknown};
    outbox?: {query?: unknown};
    resource?: object;
    link?: { open?: unknown };
  };
};

export async function ready(): Promise<boolean> {
  const shell = surface.napplet?.shell;
  if (!shell?.ready) return Boolean(surface.napplet?.relay);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([shell.ready(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Shell readiness timed out')), 5000);
    })]);
    return Boolean(surface.napplet?.relay);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const query = relay.query.bind(relay);
export const previewCatalog: Preview = (filter, receive) => {
  if (typeof surface.napplet?.relay?.subscribe === 'function') return relay.subscribe([filter], receive, () => {});
};

// A raw query may still be settling when the page stops waiting. Reuse its
// exact request on a retry instead of starting a second copy.
const pending = new Map<string, Promise<unknown>>();
export function queryCatalog(filters: NostrFilter[], expiresAt = performance.now() + PAGE_DEADLINE_MS): Promise<unknown> {
  const key = JSON.stringify(filters);
  const previous = pending.get(key);
  if (previous) return previous;
  // A nonresponsive host may never settle its SDK promise, even after a
  // manual retry chooses a different time window.
  if (pending.size >= 2) return Promise.reject(new Error('Previous directory reads still pending'));
  const request = readCatalog(filters, expiresAt).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

async function readCatalog(filters: NostrFilter[], expiresAt: number): Promise<unknown> {
  if (typeof surface.napplet?.outbox?.query === 'function') {
    const timeoutMs = Math.ceil(expiresAt - performance.now());
    if (timeoutMs < 1) throw new Error('Page deadline reached');
    const result = await outboxQuery(filters, {limit: filters[0]?.limit, timeoutMs}).catch(error => ({
      error: error instanceof Error ? error.message : 'Query unavailable',
    }));
    if (!result.error && 'events' in result && Array.isArray(result.events)) return result;
    // Portable shells may expose Outbox but require authors for this method.
    if (!['no authors', 'policy denied', 'permission denied', 'unsupported', 'unsupported method', 'authorless queries unavailable'].includes(result.error?.toLowerCase() ?? '')) {
      throw new Error('Directory query unavailable');
    }
  }
  if (performance.now() >= expiresAt) throw new Error('Page deadline reached');
  return query(filters);
}
export const canRead = () => Boolean(surface.napplet?.relay);
export const canReadResource = () => Boolean(surface.napplet?.resource);
export const canOpen = () => typeof surface.napplet?.link?.open === 'function';

export async function openPublication(publication: Publication): Promise<string> {
  try {
    const result = await linkOpen('nostr:' + publication.address);
    if (result?.status === 'opened') return 'Link accepted by your shell.';
    if (result?.status === 'denied') {
      if ('error' in result && result.error === 'unsupported-scheme') return 'This shell does not handle napplet links. The publication address is in Details.';
      if ('error' in result && result.error === 'user-denied') return 'Opening cancelled.';
      return 'Your shell declined this link.';
    }
  } catch {
    // An unavailable or interrupted link handler cannot confirm a handoff.
  }
  return 'Could not confirm the link handoff. The publication address is in Details.';
}

function setTheme(theme: Theme): boolean {
  const background = theme?.colors?.background;
  if (typeof background !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(background)) return false;
  const hex = background.length === 4 ? [...background.slice(1)].map(char => char + char).join('') : background.slice(1);
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  document.documentElement.dataset.theme = 0.2126 * red + 0.7152 * green + 0.0722 * blue >= 140 ? 'light' : 'dark';
  return true;
}

export async function connectTheme(): Promise<void> {
  let received = false;
  try {
    const subscription = themeOnChanged(theme => { received = setTheme(theme) || received; });
    window.addEventListener('pagehide', event => { if (!event.persisted) subscription.close(); });
  } catch {
    // A shell can offer theme.get without change notifications.
  }
  try {
    const theme = await themeGet();
    if (!received) setTheme(theme);
  } catch {
    // The CSS palette follows the system when the optional host theme is unavailable.
  }
}
