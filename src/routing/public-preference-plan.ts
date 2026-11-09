import type { NostrEvent } from 'nostr-tools/pure';
import { verifyQueryEvent, type QueryFilter } from '../network/relay-query-contract.ts';
import { routingRole, routingText, stableConvention } from './routing-contract.ts';
import type { CatalogHandler, CatalogSnapshot } from './routing-catalog.ts';

export type PublicPreferenceRow = Readonly<{id: string; eventId: string; archetype: string;
  current: CatalogHandler | null; target: CatalogHandler | null; references: readonly string[];
  ignoredActions: readonly string[]; unavailableReason: string | null}>;
export class PublicPreferenceError extends Error {
  constructor(message: string) {super(message); this.name = 'PublicPreferenceError';}
}
const invalid = (): never => {throw new PublicPreferenceError('Published choices could not be verified. Local defaults are unchanged.');};
const hex = /^[0-9a-f]{64}$/;
function reference(value: string, tag: string): boolean {
  routingText(value, 1024);
  if (tag === 'e') return hex.test(value);
  const match = /^(35129|15129):([0-9a-f]{64}):([\s\S]*)$/.exec(value);
  return !!match && (match[1] === '35129' ? match[3]!.length > 0 : match[3] === '');
}
function targetFor(ref: string, snapshot: CatalogSnapshot): CatalogHandler | null {
  if (hex.test(ref)) return snapshot.handlers.find(handler => handler.manifest.kind === 5129 && handler.eventId === ref) ?? null;
  const named = /^35129:([0-9a-f]{64}):([\s\S]+)$/.exec(ref);
  return named ? snapshot.handlers.find(handler => handler.manifest.kind === 35129 && handler.publisher === named[1] && handler.appId === named[2]) ?? null : null;
}
function row(event: NostrEvent, archetype: string, snapshot: CatalogSnapshot): PublicPreferenceRow {
  const referenceSet = new Set<string>(), actionSet = new Set<string>();
  let reason: string | null = null;
  for (const tag of event.tags) {
    try {
      if (tag[0] === 'a' || tag[0] === 'e') {
        if (!reference(tag[1]!, tag[0])) throw Error();
        referenceSet.add(tag[1]!);
      } else if (tag[0] === 'i') {
        const convention = stableConvention(tag[1]);
        if (!convention.startsWith('napplet:' + archetype + '/') || !reference(tag[2]!, hex.test(tag[2] ?? '') ? 'e' : 'a')) throw Error();
        const text = convention + ' → ' + tag[2];
        actionSet.add(text);
      }
    } catch {reason = 'This preference contains an unsupported or malformed choice.';}
    if (referenceSet.size > 32 || actionSet.size > 32) {
      reason = 'This preference contains more choices than this review can display.'; break;
    }
  }
  const references = [...referenceSet], ignoredActions = [...actionSet];
  const preferred = snapshot.defaults.find(value => value.archetype === archetype);
  const current = preferred ? snapshot.handlers.find(handler => handler.publisher === preferred.publisher && handler.appId === preferred.appId) ?? null : null;
  const proposed = references.length ? targetFor(references[0]!, snapshot) : null;
  if (!reason && !references.length) reason = 'No category-wide first choice is published. Your local default will stay unchanged.';
  if (!reason && !proposed) reason = 'The first choice is not a supported saved handler. Open and review that napplet first.';
  if (!reason && proposed && (proposed.manifest.format !== 'nip-5d' || !proposed.roles.some(role => role.archetype === archetype))) {
    reason = 'The first choice does not declare a supported Intent handler for this category.';
  }
  return Object.freeze({id: event.id, eventId: event.id, archetype, current, target: reason ? null : proposed,
    references: Object.freeze(references.slice(0,32)), ignoredActions: Object.freeze(ignoredActions.slice(0,32)), unavailableReason: reason});
}
/** Verify fresh event fields and select each newest coordinate before interpreting choices. */
export function planPublicPreferences(input: readonly Readonly<{event: NostrEvent}>[], account: string,
  snapshot: CatalogSnapshot): readonly PublicPreferenceRow[] {
  if (!hex.test(account) || !Array.isArray(input) || input.length > 32) return invalid();
  const filters: readonly QueryFilter[] = [{kinds:[31129],authors:[account],limit:32}];
  const latest = new Map<string,NostrEvent>();
  for (const item of input) {
    let event: NostrEvent, role: string;
    try {
      event = verifyQueryEvent(item.event, filters);
      const tags = event.tags.filter(tag => tag[0] === 'd');
      if (tags.length !== 1 || tags[0]!.length !== 2) return invalid();
      role = routingRole(tags[0]![1]);
    } catch {return invalid();}
    const previous = latest.get(role);
    if (!previous || event.created_at > previous.created_at || event.created_at === previous.created_at && event.id < previous.id) latest.set(role,event);
  }
  return Object.freeze([...latest].sort(([a],[b]) => a.localeCompare(b)).map(([role,event]) => row(event,role,snapshot)));
}
