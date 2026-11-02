import {acceptedBadges, BADGE_BUNDLE_FILTERS, fetchAcceptedBadges} from './identity-badges.ts';
import type { RelayQueryService } from '../network/native-relay-query.ts';
import { RelayQueryDataError, RelayQueryError } from '../network/relay-query-contract.ts';
import { identityResult, type CapabilityReply, type NativeRegistration } from '../runtime/capability-protocol.ts';
import {identityProjection} from './identity-projection.ts';
import { publicKey } from '../storage/codec.ts';
import type { IdentityCache } from './identity-cache.ts';
import { IDENTITY_LIMITS, IdentityDataError, identityFailure, latestIdentityEvent, verifiedIdentityEvents, type IdentityRequest, type ProfileData } from './identity-contract.ts';

export interface IdentityPermissionPort {
  authorize(registration: NativeRegistration, signal: AbortSignal, assertActive: () => void, onRevoke?: () => void): Promise<() => void>;
}
export interface IdentityDataPort {
  read(request: IdentityRequest, registration: NativeRegistration, signal: AbortSignal, assertActive: () => void): Promise<CapabilityReply>;
}
/** App-only profile read; no synthetic guest registration or guest-selected owner. */
export interface TrustedIdentityDataPort extends IdentityDataPort {
  readProfile(user: string, signal: AbortSignal, assertActive: () => void): Promise<ProfileData | null>;
}
/** Process-owned resolver. No cache, relay port, clock or owner can be selected by guest JSON. */
export function createIdentityDataService(cache: IdentityCache, queries: RelayQueryService, now: () => number = Date.now, permissions?: IdentityPermissionPort): TrustedIdentityDataPort {
  let pending = 0;
  const activeKeys = new Set<string>();
  async function resolve(request: IdentityRequest, user: string, registration: NativeRegistration | null, signal: AbortSignal, assertActive: () => void): Promise<CapabilityReply> {
    const active = () => { if (signal.aborted) throw new IdentityDataError('identity request cancelled'); assertActive(); };
    active();
    if (request.type === 'identity.getPublicKey') return identityResult(request, user);
    let projection: ReturnType<typeof identityProjection>;
    try { projection = request.type === 'identity.getBadges' ? {key: 'badges', field: 'badges', sensitive: false, filters: BADGE_BUNDLE_FILTERS, project: events => acceptedBadges(events, user)} : identityProjection(request, user); } catch (error) { return identityFailure(request, error instanceof IdentityDataError ? error.message : 'identity data unavailable'); }
    const key = user + ':' + projection.key;
    if (pending >= IDENTITY_LIMITS.concurrent || activeKeys.has(key)) return identityFailure(request, 'identity data busy');
    pending++; activeKeys.add(key);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, IDENTITY_LIMITS.timeoutMs);
    const live = () => { active(); permissionActive?.(); if (controller.signal.aborted) throw new IdentityDataError('identity request expired'); };
    let permissionActive: (() => void) | null = null;
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = () => reject(new IdentityDataError('identity request cancelled or expired')); });
    controller.signal.addEventListener('abort', rejectCancelled, { once: true });
    const work = async (): Promise<CapabilityReply> => {
      live();
      if (projection.sensitive) {
        if (!permissions || !registration) throw new IdentityDataError('public list access requires approval');
        permissionActive = await permissions.authorize(registration, controller.signal, live, stop); live();
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new IdentityDataError();
      const stored = await cache.read(user, projection.key, live, controller.signal);
      live();
      const cached = stored ? verifiedIdentityEvents(stored.events, projection.filters) : null;
      if (cached) projection.project(cached);
      let selected = cached;
      const age = stored ? timestamp - stored.fetchedAt : Infinity;
      if (cached === null || age < 0 || age >= IDENTITY_LIMITS.freshMs) {
        let fetched: readonly import('nostr-tools/pure').NostrEvent[] | undefined;
        let observed = true;
        try {
          if (projection.key === 'badges') {const bundle = await fetchAcceptedBadges(user, cached, queries, controller.signal, live); fetched = bundle.events; observed = bundle.observedRoot;}
          else {const rows = await queries.query(projection.filters, controller.signal, live); fetched = verifiedIdentityEvents(rows.map(value => value.event), projection.filters);}
        }
        catch (error) { live(); if (error instanceof IdentityDataError) throw error; if (!cached || error instanceof RelayQueryDataError || !(error instanceof RelayQueryError)) throw new IdentityDataError(); }
        live();
        if (fetched) {
          const events = verifiedIdentityEvents(fetched, projection.filters);
          projection.project(events);
          const latest = latestIdentityEvent([...(cached ?? []), ...events]);
          selected = projection.key === 'badges' ? events : latest ? Object.freeze([latest]) : Object.freeze([]);
          // An empty EOSE cannot revoke a previously observed signed replaceable event.
          if (observed && (events.length > 0 || !cached || cached.length === 0)) {
            await cache.write(user, projection.key, { fetchedAt: timestamp, events: selected }, live, controller.signal);
          }
        }
      }
      live();
      return Object.freeze({ type: `${request.type}.result`, id: request.id, [projection.field]: projection.project(selected ?? []) });
    };
    try { return await Promise.race([work(), cancelled]); } catch (error) {
      active();
      return identityFailure(request, error instanceof IdentityDataError ? error.message : 'identity data unavailable');
    } finally {
      controller.signal.removeEventListener('abort', rejectCancelled);
      activeKeys.delete(key); clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); pending--;
    }
  }
  return Object.freeze({
    read(request: IdentityRequest, registration: NativeRegistration, signal: AbortSignal, assertActive: () => void) {
      return resolve(request, publicKey(registration.user), registration, signal, assertActive);
    },
    async readProfile(user: string, signal: AbortSignal, assertActive: () => void) {
      const result = await resolve({type: 'identity.getProfile', id: 'shell-profile'}, publicKey(user), null, signal, assertActive);
      if (result.error) throw new IdentityDataError();
      return result.profile as ProfileData | null;
    },
  });
}
