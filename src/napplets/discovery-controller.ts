import type { NappletConsentReview } from './first-open-consent.ts';
import type { PublishedUpdateReview } from './published-session.ts';
import type { NappletDescriptor, Workspace } from '../shell/workspace.ts';
import { focusNapplet, openNapplet } from '../shell/workspace.ts';
import { discoveryCoordinate, isDiscoveryEntry } from './discovery-entry.ts';

type Review = (request: NappletConsentReview) => Promise<boolean>;
export interface DiscoveryControllerPorts {
  readonly address: string | null;
  workspace(): Workspace;
  visible(): boolean;
  bundled(): NappletDescriptor;
  commit(workspace: Workspace): void;
  openPublished(address: string, signal: AbortSignal, review: Review): Promise<NappletDescriptor>;
  updatePublished(session: NappletDescriptor, signal: AbortSignal,
    reviewVersion: (request: PublishedUpdateReview) => Promise<boolean>, reviewAccess: Review): Promise<NappletDescriptor | null>;
  discard(sessionId: string): void;
  beforeClose?(session: NappletDescriptor): void;
  review: Review;
  unavailable(): void;
}

function replaceCatalog(ports: DiscoveryControllerPorts, selected: NappletDescriptor, next: NappletDescriptor, active: () => void) {
  ports.beforeClose?.(selected);
  active();
  const current = ports.workspace();
  if (current.sessions.some(session => session.id === next.id)) throw new Error('Catalog session already exists');
  const sessions = current.sessions.map(session => session.id === selected.id ? next : session);
  ports.commit({sessions, focusedId: next.id, overview: false});
  if (ports.workspace().focusedId !== next.id) throw new Error('Catalog update could not be applied');
}

/** Catalog-only update policy. Other publications retain explicit version review. */
export function createDiscoveryController(ports: DiscoveryControllerPorts) {
  let pending: AbortController | null = null;
  let disposed = false;
  const entry = (session: NappletDescriptor) => isDiscoveryEntry(session, ports.address);
  const cancel = () => {
    const previous = pending;
    pending = null;
    previous?.abort();
  };
  return Object.freeze({
    open(): void {
      if (disposed) return;
      const state = ports.workspace();
      const existing = state.sessions.find(entry);
      if (existing) ports.commit(focusNapplet(state, existing.id));
      else if (state.sessions.length < 64) ports.commit(openNapplet(state, ports.bundled()));
    },
    async refresh(): Promise<void> {
      if (disposed || pending || ports.address === null || !ports.visible()) return;
      const coordinate = discoveryCoordinate(ports.address);
      const workspace = ports.workspace();
      const selected = workspace.sessions.find(session => session.id === workspace.focusedId && entry(session));
      if (!coordinate || !selected) return;
      const controller = new AbortController();
      pending = controller;
      let candidate: NappletDescriptor | null = null;
      let committed = false;
      const reviewed: {update?: PublishedUpdateReview; access?: {eventId: string; approved: boolean}} = {};
      const active = () => {
        const state = ports.workspace();
        const current = state.sessions.find(session => session.id === selected.id);
        if (disposed || controller.signal.aborted || !ports.visible() || state.focusedId !== selected.id ||
            !current || current.source !== selected.source || current.publisher !== selected.publisher || current.appId !== selected.appId ||
            current.eventId !== selected.eventId || current.version !== selected.version) throw new Error('Catalog update cancelled');
      };
      const reviewVersion = async (request: PublishedUpdateReview) => {
        active();
        if (reviewed.update || request.publisher !== coordinate.pubkey || request.appId !== coordinate.identifier ||
            request.previousEventId !== selected.eventId || request.previousVersion !== selected.version ||
            request.nextEventId === selected.eventId) throw new Error('Invalid catalog update review');
        reviewed.update = request;
        return true;
      };
      const review: Review = async request => {
        active();
        if (reviewed.access || request.publisher !== coordinate.pubkey || request.appId !== coordinate.identifier ||
            (selected.source === 'published' && request.eventId !== reviewed.update?.nextEventId)) {
          throw new Error('Invalid catalog access review');
        }
        const access = {eventId: request.eventId, approved: false};
        reviewed.access = access;
        const accepted = await ports.review(request);
        active();
        access.approved = accepted === true;
        return access.approved;
      };
      try {
        active();
        candidate = selected.source === 'published'
          ? await ports.updatePublished(selected, controller.signal, reviewVersion, review)
          : await ports.openPublished(ports.address, controller.signal, review);
        active();
        if (!candidate) return;
        const state = ports.workspace();
        if (candidate.source !== 'published' || !entry(candidate) || state.sessions.some(session => session.id === candidate!.id) ||
            (reviewed.access && (!reviewed.access.approved || candidate.eventId !== reviewed.access.eventId)) ||
            (selected.source === 'published' &&
              (candidate.eventId !== reviewed.update?.nextEventId || candidate.version !== reviewed.update?.nextVersion))) {
          throw new Error('Invalid catalog update');
        }
        replaceCatalog(ports, selected, candidate, active);
        committed = true;
        if (selected.source === 'published') ports.discard(selected.id);
      } catch {
        if (!disposed && !controller.signal.aborted) ports.unavailable();
      } finally {
        if (candidate && !committed && !ports.workspace().sessions.some(session => session.id === candidate!.id)) ports.discard(candidate.id);
        if (pending === controller) pending = null;
      }
    },
    cancel,
    dispose(): void { disposed = true; cancel(); },
  });
}
