import type { IdentityTransition } from '../security/identity-transition.ts';
import type { DetailedRelayQueryService } from '../network/native-relay-query.ts';
import type { RoutingNativePort } from './routing-port.ts';
import type { CatalogSnapshot, RoutingCatalog } from './routing-catalog.ts';
import type { RoutingBroker } from './routing-broker.ts';
import type { ReviewSlot } from '../shell/review-slot.ts';
import { ShellStorageError, type RequestOptions, type TrustedUser } from '../storage/ports.ts';
import { planPublicPreferences, PublicPreferenceError, type PublicPreferenceRow } from './public-preference-plan.ts';
export type { PublicPreferenceRow } from './public-preference-plan.ts';
export type PublicPreferenceReview = Readonly<{account: string; rows: readonly PublicPreferenceRow[]; limited: boolean}>;
export type PublicPreferenceImportResult = Readonly<{status: 'saved'; snapshot: CatalogSnapshot}> | Readonly<{status: 'saved-refresh-failed'}>;
export interface PublicPreferenceImportService {
  preview(options?: RequestOptions): Promise<PublicPreferenceReview>;
  accept(review: PublicPreferenceReview, rowId: string, options?: RequestOptions): Promise<PublicPreferenceImportResult>;
  cancel(review: PublicPreferenceReview): void;
}
type Dependencies = Readonly<{identity: Pick<IdentityTransition,'sessionAuthority'>; native: RoutingNativePort;
  catalog: RoutingCatalog; broker: Pick<RoutingBroker,'catalogChanged'>; queries: DetailedRelayQueryService;
  relays(): readonly string[]; slot: Pick<ReviewSlot,'reserveRouting'|'releaseRouting'|'owns'>; now?: () => number}>;
type Pending = {review: PublicPreferenceReview; owner: TrustedUser; signal?: AbortSignal; slotId: string;
  consumed: boolean; release(): void};
/** App-only review. Public data never grants access, installs an app or invokes a handler. */
export function createPublicPreferenceImport(deps: Dependencies): PublicPreferenceImportService {
  let pending: Pending | null = null, sequence = 0;
  const now = deps.now ?? (() => performance.now());
  function cancel(review: PublicPreferenceReview) {if (pending?.review === review) {const old = pending; pending = null; old.release();}}
  return Object.freeze({
    async preview(options?: RequestOptions) {
      if (pending) cancel(pending.review);
      const ticket = ++sequence, authority = deps.identity.sessionAuthority(), state = deps.native.state();
      const relays = JSON.stringify(deps.relays()), expires = now() + 300_000;
      const active = () => {
        authority.assertActive(); const current = deps.native.state();
        if (ticket !== sequence || options?.signal?.aborted || now() >= expires || !current.available || !current.foreground ||
          current.user !== authority.user || current.epoch !== authority.epoch || current.revision !== state.revision || JSON.stringify(deps.relays()) !== relays) throw new ShellStorageError('REVOKED');
      };
      const owner = Object.freeze({user: authority.user, assertActive: active}); active();
      const controller = new AbortController(), signal = options?.signal ?? controller.signal;
      const slotId = 'public-preference-import-' + ticket;
      if (!deps.slot.reserveRouting({id:slotId,origin:{sessionId:slotId,generation:slotId,epoch:authority.epoch}})) {
        throw new PublicPreferenceError('Another review is open. Finish it before importing app choices.');
      }
      let review: PublicPreferenceReview | null = null;
      const release = () => {deps.slot.releaseRouting(slotId); signal.removeEventListener('abort', aborted);};
      const aborted = () => {if (review) cancel(review); else release();};
      const reviewing = () => {active(); if (!deps.slot.owns('routing',slotId)) throw new ShellStorageError('REVOKED');};
      signal.addEventListener('abort',aborted,{once:true});
      try {
        reviewing();
        const result = await deps.queries.queryDetailed([{kinds:[31129],authors:[authority.user],limit:32}], signal, reviewing);
        reviewing();
        if (result.incomplete) throw new PublicPreferenceError('Some Network relays did not complete the lookup. Local defaults are unchanged. Try again later.');
        const snapshot = await deps.catalog.inspect(owner, options); reviewing();
        review = Object.freeze({account: authority.user, rows: planPublicPreferences(result.events, authority.user, snapshot), limited: result.events.length === 32});
        pending = {review,owner,signal,slotId,consumed:false,release};
        return review;
      } catch (error) {release(); throw error;}
    },
    async accept(review: PublicPreferenceReview, rowId: string, options?: RequestOptions) {
      const operation = pending;
      if (!operation || operation.review !== review || operation.consumed) throw new ShellStorageError('REVOKED');
      operation.consumed = true;
      const owner = Object.freeze({user:operation.owner.user,assertActive() {
        operation.owner.assertActive();
        if (pending !== operation || options?.signal?.aborted || !deps.slot.owns('routing',operation.slotId)) throw new ShellStorageError('REVOKED');
      }});
      try {
        owner.assertActive();
        const selected = review.rows.find(row => row.id === rowId);
        if (!selected?.target || selected.unavailableReason) throw new ShellStorageError('INVALID_INPUT');
        const {target,current,archetype} = selected;
        await deps.catalog.importDefault(owner,{archetype,current:current ? {publisher:current.publisher,appId:current.appId} : null,
          target:{publisher:target.publisher,appId:target.appId,eventId:target.eventId,version:target.version}},options);
        // The transaction has committed. A later notification/refresh failure cannot undo it.
        try {
          owner.assertActive(); await deps.broker.catalogChanged(owner,[archetype],{readOnly:true}); owner.assertActive();
          return Object.freeze({status:'saved' as const,snapshot:await deps.catalog.inspect(owner, options)});
        } catch {return Object.freeze({status:'saved-refresh-failed' as const});}
      } finally {cancel(review);}
    },
    cancel,
  });
}
