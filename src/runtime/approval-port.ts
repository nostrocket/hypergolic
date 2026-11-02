import {parseOutboxPublish} from '../outbox/publication-contract.ts';
import { decodeNativeRequest } from './capability-protocol.ts';
import { text } from '../storage/codec.ts';
import type { NativeApprovalLease, NativeApprovalLeasePort } from '../security/approval-service.ts';

export interface ApprovalModule {
  takeApproval(token: string): string | null;
  prepareApprovalSigning(token: string, snapshotJSON: string): boolean;
  prepareOutboxApproval?(token:string,plan:string):boolean;
  failOutboxApproval?(token:string,error:string):void;
  publishOutboxApproval?(token:string,group:string,event:string,relay:string):Promise<string>;
  isApprovalLive(token: string): boolean;
  mayReviewApproval(token: string): boolean;
  approveApproval(token: string): boolean;
  isApprovalApproved(token: string): boolean;
  dismissApproval(token: string): void;
  cancelApproval(token: string): void;
  finishApproval(token: string, response: string | null): void;
  resumeApprovals(): void;
}
/** Native tokens stay private to the adapter; a guest cannot manufacture a lease object. */
export function createNativeApprovalPort(module: ApprovalModule): NativeApprovalLeasePort {
  const tokens = new WeakMap<NativeApprovalLease, string>();
  const tokenFor = (lease: NativeApprovalLease): string => {
    const token = tokens.get(lease);
    if (!token) throw new Error('APPROVAL_DENIED');
    return token;
  };
  return Object.freeze<NativeApprovalLeasePort>({
    take(token: string) {
      const raw = module.takeApproval(token);
      if (raw === null) return null;
      try {
        const { registration, request } = decodeNativeRequest(raw);
        if (!registration.domains.includes('relay') || !request || typeof request !== 'object' || Array.isArray(request)) throw new Error('APPROVAL_DENIED');
        const fields = Object.keys(request);
        const value = request as Record<string, unknown>;
        const outbox=value.type==='outbox.publish';
        if(outbox&&!registration.domains.includes('outbox'))throw new Error('APPROVAL_DENIED');
        if(!outbox&&(fields.length!==3||!fields.includes('event')||value.type!=='relay.publish'))throw new Error('APPROVAL_DENIED');
        const outboxRequest=outbox?parseOutboxPublish(value,registration.user):undefined;
        const requestId = text(value.id, 128);
        const lease = Object.freeze({});
        tokens.set(lease, token);
        return Object.freeze({ lease, origin: registration, requestId, event: value.event,...(outboxRequest?{outboxRequest}:{}) });
      } catch {
        try { module.cancelApproval(token); } finally { module.finishApproval(token, null); }
        return null;
      }
    },
    prepareOutbox:(lease,plan)=>module.prepareOutboxApproval?.(tokenFor(lease),JSON.stringify(plan))??false,
    failOutbox(lease,error){const token=tokenFor(lease);tokens.delete(lease);if(module.failOutboxApproval)module.failOutboxApproval(token,error);else{module.cancelApproval(token);module.finishApproval(token,null);}},
    async publishOutbox(lease,group,event,destinations,execution){
      const token=tokenFor(lease);if(!module.publishOutboxApproval)throw new Error('APPROVAL_DENIED');
      const rows:unknown[]=[],publish=module.publishOutboxApproval.bind(module),wire=JSON.stringify(event);
      async function worker(index:number):Promise<void>{if(index>=destinations.length)return;execution.assertActive();const raw=await publish(token,group,wire,destinations[index]!);execution.assertActive();rows[index]=JSON.parse(raw);return worker(index+4);}
      await Promise.all([worker(0),worker(1),worker(2),worker(3)]);execution.assertActive();return Object.freeze(rows) as Awaited<ReturnType<NonNullable<NativeApprovalLeasePort['publishOutbox']>>>;
    },
    prepareSigning: (lease, snapshot) => module.prepareApprovalSigning(tokenFor(lease), JSON.stringify(snapshot)),
    signingSource: lease => Object.freeze({ kind: 'approval', token: tokenFor(lease) }),
    isLive: lease => module.isApprovalLive(tokenFor(lease)),
    mayReview: lease => module.mayReviewApproval(tokenFor(lease)),
    approveOnce: lease => module.approveApproval(tokenFor(lease)),
    isApproved: lease => module.isApprovalApproved(tokenFor(lease)),
    dismiss: lease => module.dismissApproval(tokenFor(lease)),
    cancel: lease => module.cancelApproval(tokenFor(lease)),
    resume: () => module.resumeApprovals(),
    finish(lease, response = null) {
      const token = tokenFor(lease);
      tokens.delete(lease);
      module.finishApproval(token, response);
    },
  });
}
