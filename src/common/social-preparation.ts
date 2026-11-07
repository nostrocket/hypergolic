import type {ApprovalOrigin,NativeTakenApproval,NativeApprovalLeasePort,TrustedApprovalOwner} from '../security/approval-service.ts';
import type {CommonSocialPlan,CommonSocialPlanner} from './social-plan.ts';
import {CommonError} from './common-contract.ts';
type Preparing=Readonly<{taken:NativeTakenApproval;controller:AbortController}>;
/** Native original intent is immutable; preparation alone cannot approve, sign or send. */
export class CommonApprovalPreparation{
  private rows:Preparing[]=[];
  private readonly native:NativeApprovalLeasePort;
  private readonly owner:TrustedApprovalOwner;
  private readonly planner:CommonSocialPlanner|undefined;
  private readonly foreground:()=>boolean;
  private readonly ready:(taken:NativeTakenApproval,plan:CommonSocialPlan)=>void;
  private readonly changed:()=>void;
  constructor(native:NativeApprovalLeasePort,owner:TrustedApprovalOwner,planner:CommonSocialPlanner|undefined,foreground:()=>boolean,
    ready:(taken:NativeTakenApproval,plan:CommonSocialPlan)=>void,changed:()=>void){
    this.native=native;this.owner=owner;this.planner=planner;this.foreground=foreground;this.ready=ready;this.changed=changed;
  }
  origins():readonly ApprovalOrigin[]{return this.rows.map(row=>row.taken.origin);}
  start(taken:NativeTakenApproval):boolean{
    if(!this.planner||!taken.commonRequest||!taken.commonRegistration||!this.native.prepareCommon||!this.native.completeCommonNoop||!this.native.failCommon||!this.native.publishOutbox)return false;
    const row=Object.freeze({taken,controller:new AbortController()});this.rows.push(row);this.changed();void this.resolve(row);return true;
  }
  private active(row:Preparing){
    this.owner.assertActive(row.taken.origin,'common');
    if(!this.foreground()||!this.rows.includes(row)||row.controller.signal.aborted||!this.native.isLive(row.taken.lease))throw new CommonError('user-denied');
  }
  private async resolve(row:Preparing){
    const watch=setInterval(()=>{try{this.active(row);}catch{this.cancel(origin=>origin===row.taken.origin);}},25);
    const deadline=setTimeout(()=>row.controller.abort(),15_000);let plan:CommonSocialPlan|undefined,transferred=false;
    try{
      this.active(row);plan=await this.planner!.plan(row.taken.commonRequest,row.taken.commonRegistration!,row.controller.signal,()=>this.active(row));this.active(row);
      if(!plan.publication){if(!this.native.completeCommonNoop!(row.taken.lease,plan))throw new CommonError('user-denied');}
      else{if(!this.native.prepareCommon!(row.taken.lease,plan))throw new CommonError('user-denied');this.active(row);this.ready(row.taken,plan);transferred=true;}
    }catch(error){if(this.rows.includes(row))try{this.native.failCommon!(row.taken.lease,error instanceof CommonError?error.message:'relay-timeout');}catch{try{this.native.cancel(row.taken.lease);}catch{/* Native teardown still revokes its source. */}try{this.native.finish(row.taken.lease);}catch{/* Expiry remains authoritative. */}}}
    finally{clearInterval(watch);clearTimeout(deadline);row.controller.abort();if(plan&&!transferred)this.planner!.release(plan);this.rows=this.rows.filter(value=>value!==row);this.changed();}
  }
  cancel(matches:(origin:ApprovalOrigin)=>boolean){
    const removed=this.rows.filter(row=>matches(row.taken.origin));this.rows=this.rows.filter(row=>!matches(row.taken.origin));
    for(const row of removed){row.controller.abort();try{this.native.cancel(row.taken.lease);}catch{/* Native expiry remains authoritative. */}try{this.native.finish(row.taken.lease);}catch{/* Continue exact remaining cleanup. */}}
    if(removed.length)this.changed();
  }
  refresh(){this.cancel(origin=>{const row=this.rows.find(value=>value.taken.origin===origin)!;try{return !this.native.isLive(row.taken.lease);}catch{return true;}});}
}
