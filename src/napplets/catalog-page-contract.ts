import { routingRecord, routingText } from '../routing/routing-contract.ts';

export const CATALOG_PAGE = 'relay.catalogPage';
export const CATALOG_PAGE_LIMIT = 20;
export const CATALOG_PAGE_EVENT_LIMIT = 32;
export type CatalogPageRequest = Readonly<{type: typeof CATALOG_PAGE; id: string; reset: boolean; round: string; after: number}>;
export type CatalogPage = Readonly<{
  page: number; until: number; events: readonly unknown[];
  more: boolean; partial: boolean; gap: boolean; bounded: boolean;
}>;

const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

export function parseCatalogPageRequest(value: unknown): CatalogPageRequest {
  const {type, id, reset, round, after} = routingRecord(value, ['type', 'id', 'reset', 'round', 'after']);
  if (type !== CATALOG_PAGE || typeof reset !== 'boolean' || typeof round !== 'string' || !/^[0-9a-f]{32}$/.test(round) ||
      !integer(after, CATALOG_PAGE_LIMIT) ||
      (reset && after !== 0)) throw Error('Invalid catalog page request');
  return Object.freeze({type, id: routingText(id, 128), reset, round, after});
}

export function parseCatalogPage(value: unknown): CatalogPage {
  const {page, until, events, more, partial, gap, bounded} = routingRecord(value,
    ['page', 'until', 'events', 'more', 'partial', 'gap', 'bounded']);
  if (!integer(page, CATALOG_PAGE_LIMIT) || page === 0 || !integer(until) ||
      !Array.isArray(events) || events.length > CATALOG_PAGE_EVENT_LIMIT ||
      typeof more !== 'boolean' || typeof partial !== 'boolean' ||
      typeof gap !== 'boolean' || typeof bounded !== 'boolean' || (bounded && more)) throw Error('Invalid catalog page');
  return Object.freeze({page, until, events, more, partial, gap, bounded});
}
