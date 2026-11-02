import type { NappletConsentReview } from '../napplets/first-open-consent.ts';
import type { NativeRegistration } from '../runtime/capability-protocol.ts';
import type { IntentRequest } from './routing-contract.ts';
import type { CatalogHandler } from './routing-catalog.ts';
export type RoutingReviewRequest = Readonly<{ kind: 'intent'; origin: NativeRegistration; request: IntentRequest; candidates: readonly CatalogHandler[]; selected: CatalogHandler | null; newInstance: boolean }>
  | Readonly<{ kind: 'topic'; origin: NativeRegistration; topic: string }>
  | Readonly<{ kind: 'channel'; origin: NativeRegistration; peer: NativeRegistration }>
  | Readonly<{ kind: 'permissions'; origin: NativeRegistration; consent: NappletConsentReview }>;
export type RoutingDecision = Readonly<{ allow: boolean; selected?: CatalogHandler; remember?: boolean }>;
export type RoutingReviewItem = Readonly<{ id: string; request: RoutingReviewRequest }>;
type Pending = RoutingReviewItem & { active(): void; mayReview(): boolean; resolve(value: RoutingDecision): void };
const denied: RoutingDecision = Object.freeze({ allow: false });
/** Presentation only. Each answer is checked against its exact still-live native request. */
export class RoutingReviewService {
  private pending: Pending[] = [];
  private counter = 0;
  private listeners = new Set<() => void>();
  private snapshot: RoutingReviewItem | null = null;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): RoutingReviewItem | null => this.snapshot;
  private publish() {
    const item = this.pending.find(entry => { try { entry.active(); return entry.mayReview(); } catch { return false; } });
    if (item?.id === this.snapshot?.id) return;
    this.snapshot = item ? Object.freeze({ id: item.id, request: item.request }) : null;
    for (const listener of this.listeners) try { listener(); } catch { /* Presentation cannot grant or retain authority. */ }
  }
  refresh() {
    for (const entry of this.pending) {
      try { entry.active(); } catch { this.end(entry, denied); }
    }
    this.publish();
  }
  private end(entry: Pending, decision: RoutingDecision) {
    this.pending = this.pending.filter(value => value !== entry); entry.resolve(decision);
  }
  ask(request: RoutingReviewRequest, active: () => void, mayReview: () => boolean): Promise<RoutingDecision> {
    this.refresh();
    try { active(); } catch { return Promise.resolve(denied); }
    if (this.pending.length >= 8 || this.pending.filter(entry => entry.request.origin.generation === request.origin.generation).length >= 4 || this.counter >= Number.MAX_SAFE_INTEGER) return Promise.resolve(denied);
    return new Promise(resolve => {
      this.pending.push({ id: 'routing-review-' + ++this.counter, request, active, mayReview, resolve }); this.publish();
    });
  }
  decide(id: string, decision: RoutingDecision): void {
    this.refresh();
    const entry = this.pending.find(value => value.id === id);
    if (!entry || this.snapshot?.id !== id) return;
    try {
      entry.active(); if (!entry.mayReview()) throw new Error('Review unavailable');
      if (decision.allow && entry.request.kind === 'intent') {
        const selected = decision.selected ?? entry.request.selected;
        if (!selected || !entry.request.candidates.includes(selected) || (entry.request.selected !== null && entry.request.selected !== selected)) throw new Error('Handler unavailable');
        this.end(entry, Object.freeze({ allow: true, selected, remember: decision.remember === true }));
      } else this.end(entry, Object.freeze({ allow: decision.allow === true }));
    } catch { this.end(entry, denied); }
    this.publish();
  }
  cancelAll() { for (const entry of this.pending) this.end(entry, denied); this.publish(); }
  close(generation: string) { for (const entry of this.pending) if ((entry.request.origin.generation === generation || (entry.request.kind === 'channel' && entry.request.peer.generation === generation))) this.end(entry, denied); this.publish(); }
}
