import type {ApprovalOrigin,NativeTakenApproval,NativeApprovalLeasePort,TrustedApprovalOwner} from '../security/approval-service.ts';
import type {OutboxPublicationPlan,createOutboxPublicationPlanner} from './publication-plan.ts';
import {OutboxPublicationError} from './publication-contract.ts';
export type OutboxPublicationPlanner=ReturnType<typeof createOutboxPublicationPlanner>;
type Preparing=Readonly<{taken:NativeTakenApproval;controller:AbortController}>;
/** Preparing requests reserve presentation capacity but cannot be reviewed or signed. */
export class OutboxApprovalPreparation {
  private rows:Preparing[]=[];
  private readonly native:NativeApprovalLeasePort;
  private readonly owner:TrustedApprovalOwner;
  private readonly planner:OutboxPublicationPlanner|undefined;
  private readonly foreground:()=>boolean;
  private readonly ready:(taken:NativeTakenApproval,plan:OutboxPublicationPlan)=>void;
  private readonly changed:()=>void;
  constructor(native:NativeApprovalLeasePort,owner:TrustedApprovalOwner,planner:OutboxPublicationPlanner|undefined,
    foreground:()=>boolean,ready:(taken:NativeTakenApproval,plan:OutboxPublicationPlan)=>void,changed:()=>void){
    this.native=native;this.owner=owner;this.planner=planner;this.foreground=foreground;this.ready=ready;this.changed=changed;
  }
  origins():readonly ApprovalOrigin[]{return this.rows.map(row=>row.taken.origin);}
  start(taken:NativeTakenApproval):boolean {
    if(!this.planner||!this.native.prepareOutbox||!this.native.failOutbox||!this.native.publishOutbox)return false;
    const row=Object.freeze({taken,controller:new AbortController()});this.rows.push(row);this.changed();void this.resolve(row);return true;
  }
  private active(row:Preparing):void {
    this.owner.assertActive(row.taken.origin,'outbox');
    if(!this.foreground()||!this.rows.includes(row)||row.controller.signal.aborted||!this.native.isLive(row.taken.lease))throw new Error('APPROVAL_DENIED');
  }
  private async resolve(row:Preparing):Promise<void>{
    const {taken,controller}=row,watch=setInterval(()=>{try{this.active(row);}catch{this.cancel(origin=>origin===taken.origin);}},25);
    try {
      this.active(row);const plan=await this.planner!.plan(taken.outboxRequest,taken.origin.user,controller.signal,()=>this.active(row));this.active(row);
      if(!this.native.prepareOutbox!(taken.lease,plan))throw new Error('APPROVAL_DENIED');this.active(row);
      this.ready(taken,plan);
    } catch(error) {
      if(this.rows.includes(row))try{this.native.failOutbox!(taken.lease,error instanceof OutboxPublicationError ? error.message : 'approval denied');}catch{try{this.native.cancel(taken.lease);this.native.finish(taken.lease);}catch{/* Native revocation wins. */}}
    } finally {clearInterval(watch);controller.abort();this.rows=this.rows.filter(value=>value!==row);this.changed();}
  }
  cancel(matches:(origin:ApprovalOrigin)=>boolean):void {
    const removed=this.rows.filter(row=>matches(row.taken.origin));this.rows=this.rows.filter(row=>!matches(row.taken.origin));
    for(const row of removed){row.controller.abort();try{this.native.cancel(row.taken.lease);}catch{/* Continue cleanup. */}try{this.native.finish(row.taken.lease);}catch{/* Native expiry remains authoritative. */}}
    if(removed.length)this.changed();
  }
  refresh():void {this.cancel(origin=>{const row=this.rows.find(value=>value.taken.origin===origin)!;try{return !this.native.isLive(row.taken.lease);}catch{return true;}});}
}
