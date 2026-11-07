import {parseCommonRequest,CommonError,type CommonSocialRequest} from '../common/common-contract.ts';
import {hasCommonSocial} from '../common/social-plan.ts';
import {parseOutboxPublish} from '../outbox/publication-contract.ts';
import { decodeNativeRequest } from './capability-protocol.ts';
import { text } from '../storage/codec.ts';
import type { NativeApprovalLease, NativeApprovalLeasePort } from '../security/approval-service.ts';

export interface ApprovalModule {
  takeApproval(token: string): string | null;
  prepareApprovalSigning(token: string, snapshotJSON: string): boolean;
  prepareCommonApproval?(token:string,plan:string):boolean;
  completeCommonNoop?(token:string,plan:string):boolean;
  failCommonApproval?(token:string,error:string):void;
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
  const cancelCaptured=(token:string):void=>{
    let failure:unknown;
    try{module.cancelApproval(token);}catch(error){failure=error;}
    try{module.finishApproval(token,null);}catch(error){failure??=error;}
    if(failure)throw failure;
  };
  return Object.freeze<NativeApprovalLeasePort>({
    take(token: string) {
      const raw = module.takeApproval(token);
      if (raw === null) return null;
      let common=false;
      try {
        const { registration, request } = decodeNativeRequest(raw);
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('APPROVAL_DENIED');
        const fields = Object.keys(request);
        const value = request as Record<string, unknown>;
        const outbox=value.type==='outbox.publish';common=['common.follow','common.unfollow','common.react','common.report'].includes(value.type as string);
        if(common&&!hasCommonSocial(registration))throw new Error('APPROVAL_DENIED');
        if (!registration.domains.includes(common?'common':outbox ? 'outbox' : 'relay')) throw new Error('APPROVAL_DENIED');
        if(!outbox&&!common&&(fields.length!==3||!fields.includes('event')||value.type!=='relay.publish'))throw new Error('APPROVAL_DENIED');
        const outboxRequest=outbox?parseOutboxPublish(value,registration.user):undefined;
        const commonRequest=common?parseCommonRequest(value) as CommonSocialRequest:undefined;
        const requestId = text(value.id, 128);
        const lease = Object.freeze({});
        tokens.set(lease, token);
        return Object.freeze({ lease, origin: registration, requestId, event: value.event,...(outboxRequest?{outboxRequest}:{}),...(commonRequest?{commonRequest,commonRegistration:registration}:{}) });
      } catch(error) {
        if(common&&module.failCommonApproval){try{module.failCommonApproval(token,error instanceof CommonError?error.message:'invalid-target');}catch{try{cancelCaptured(token);}catch{/* Cleanup was attempted; native lifecycle and expiry remain authoritative. */}}return null;}
        try { module.cancelApproval(token); } finally { module.finishApproval(token, null); }
        return null;
      }
    },
    prepareCommon:(lease,plan)=>module.prepareCommonApproval?.(tokenFor(lease),JSON.stringify(plan))??false,
    completeCommonNoop(lease,plan){const token=tokenFor(lease),ok=module.completeCommonNoop?.(token,JSON.stringify(plan))??false;if(ok)tokens.delete(lease);return ok;},
    failCommon(lease,error){
      const token=tokenFor(lease);
      try{
        if(module.failCommonApproval){try{module.failCommonApproval(token,error);}catch(failure){try{cancelCaptured(token);}catch{/* Preserve the original failure after both cleanup calls. */}throw failure;}}
        else cancelCaptured(token);
      }finally{tokens.delete(lease);}
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
