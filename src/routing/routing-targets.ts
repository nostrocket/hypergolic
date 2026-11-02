import type { IdentityTransition } from '../security/identity-transition.ts';
import type { RuntimeOwner } from '../runtime/runtime-owner.ts';
import { focusNapplet, openNapplet } from '../shell/workspace.ts';
import { ShellStorageError } from '../storage/ports.ts';
import type { RoutingTargetPort } from './routing-broker.ts';
import type { RoutingNativePort } from './routing-port.ts';
import type { RoutingReviewService } from './routing-review.ts';
/** Uses the ordinary pinned published-session path; navigation never manufactures a guest endpoint. */
export function createRoutingTargets(identity: Pick<IdentityTransition, 'getSnapshot'>, runtime: () => RuntimeOwner | null,
  reviews: RoutingReviewService, native: RoutingNativePort): RoutingTargetPort {
  return Object.freeze({ async activate(handler, request, signal, active, origin, revision) {
    active();
    const state = identity.getSnapshot();
    if (state.phase !== 'ready' || state.session.vault.selectedPubkey !== origin.user || state.session.epoch !== origin.epoch || signal.aborted) throw new ShellStorageError('REVOKED');
    const controller = state.session.workspace, before = controller.getSnapshot();
    if (before.error !== null) throw new ShellStorageError('REVOKED');
    const forceNew = request.behavior?.newWindow === true || request.behavior?.reuse === false;
    const existing = forceNew ? undefined : before.workspace.sessions.find(session => session.source === 'published' && session.publisher === handler.publisher && session.appId === handler.appId && session.version === handler.version && session.eventId === handler.eventId);
    if (existing) {
      if (request.behavior?.focus !== false) controller.change(focusNapplet(controller.getSnapshot().workspace, existing.id));
      await controller.flush(); active();
      if (controller.getSnapshot().error !== null) throw new ShellStorageError('REVOKED');
      return existing.id;
    }
    if (before.workspace.sessions.length >= 64) throw new ShellStorageError('QUOTA_EXCEEDED');
    const owner = runtime(); if (!owner) throw new ShellStorageError('REVOKED');
    const descriptor = await owner.prepareInstalled(handler, signal, async consent => {
      active();
      const decision = await reviews.ask(Object.freeze({ kind: 'permissions', origin, consent }), active, () => native.mayReview(origin.generation, revision));
      active(); return decision.allow;
    });
    try {
      active();
      const previous = controller.getSnapshot().workspace;
      const opened = openNapplet(previous, descriptor);
      controller.change(request.behavior?.focus === false ? { ...opened, focusedId: previous.focusedId, overview: previous.overview } : opened);
      await controller.flush(); active();
      if (controller.getSnapshot().error !== null || !controller.getSnapshot().workspace.sessions.some(session => session.id === descriptor.id)) throw new ShellStorageError('REVOKED');
      return descriptor.id;
    } catch (error) { owner.discardPublished(descriptor.id); throw error; }
  } });
}
