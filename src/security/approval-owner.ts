import type { IdentityTransition } from './identity-transition.ts';
import type { ApprovalOrigin, TrustedApprovalOwner } from './approval-service.ts';
import { resolveBundledSession } from '../shell/fixtures.ts';

/** Resolve persisted descriptors through the same trusted catalogue as native registration. */
function createCapabilityOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'sessionAuthority'>,
  domain: 'relay' | 'upload', assertPublished?: (origin: ApprovalOrigin,domain?:'outbox') => void): TrustedApprovalOwner {
  return Object.freeze({ assertActive(origin: ApprovalOrigin,requestedDomain?:'outbox') {
    const authority = identity.sessionAuthority();
    authority.assertActive();
    const state = identity.getSnapshot().session.workspace.getSnapshot();
    const session = state.workspace.sessions.find(value => value.id === origin.sessionId);
    if (authority.epoch !== origin.epoch || authority.user !== origin.user || state.error !== null || !session) throw new Error('APPROVAL_DENIED');
    if (session.source === 'published') {
      if (!assertPublished) throw new Error('APPROVAL_DENIED');
      assertPublished(origin,requestedDomain);
      return;
    }
    const catalog = resolveBundledSession(session);
    if(requestedDomain==='outbox'&&!catalog.domains.includes('outbox'))throw new Error('APPROVAL_DENIED');
    if (!catalog.domains.includes(domain) || catalog.publisher !== origin.publisher || catalog.appId !== origin.appId ||
        catalog.version !== origin.version || catalog.instanceId !== origin.instanceId) throw new Error('APPROVAL_DENIED');
  } });
}

export function createApprovalOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'sessionAuthority'>,
  assertPublished?: (origin: ApprovalOrigin,domain?:'outbox') => void): TrustedApprovalOwner {
  return createCapabilityOwner(identity, 'relay', assertPublished);
}
export function createUploadOwner(identity: Pick<IdentityTransition, 'getSnapshot' | 'sessionAuthority'>,
  assertPublished?: (origin: ApprovalOrigin,domain?:'outbox') => void): TrustedApprovalOwner {
  return createCapabilityOwner(identity, 'upload', assertPublished);
}
