import type {ApprovalOrigin,NativeTakenApproval,NativeApprovalLeasePort,TrustedApprovalOwner} from '../security/approval-service.ts';
import {AppDataPublicationError,appDataFailure,type AppDataPlan,type AppDataPlanner} from './app-data-plan.ts';
type Preparing=Readonly<{taken:NativeTakenApproval;controller:AbortController}>;
/** Scope/revision preparation is not consent. Native original lease and eventual user decision remain required. */
export class AppDataApprovalPreparation{
  private rows:Preparing[]=[];
  private readonly native:NativeApprovalLeasePort;
  private readonly owner:TrustedApprovalOwner;
  private readonly planner:AppDataPlanner|undefined;
  private readonly foreground:()=>boolean;
  private readonly ready:(taken:NativeTakenApproval,plan:AppDataPlan)=>void;
  private readonly changed:()=>void;
  constructor(native:NativeApprovalLeasePort,owner:TrustedApprovalOwner,planner:AppDataPlanner|undefined,
    foreground:()=>boolean,ready:(taken:NativeTakenApproval,plan:AppDataPlan)=>void,changed:()=>void){
    this.native=native;this.owner=owner;this.planner=planner;this.foreground=foreground;this.ready=ready;this.changed=changed;
  }
  origins():readonly ApprovalOrigin[]{return this.rows.map(row=>row.taken.origin);}
  start(taken:NativeTakenApproval):boolean{
    if(!this.planner||!taken.appDataRequest||!taken.appDataRegistration||(!this.native.prepareOutbox||!this.native.failOutbox))return false;
    const row=Object.freeze({taken,controller:new AbortController()});this.rows.push(row);this.changed();void this.resolve(row);return true;
  }
  private active(row:Preparing):void{
    this.owner.assertActive(row.taken.origin,row.taken.outboxRequest?'outbox':undefined);
    if(!this.foreground()||!this.rows.includes(row)||row.controller.signal.aborted||!this.native.isLive(row.taken.lease))throw new AppDataPublicationError('app-data-cancelled');
  }
  private async resolve(row:Preparing):Promise<void>{
    const watch=setInterval(()=>{try{this.active(row);}catch{this.cancel(origin=>origin===row.taken.origin);}},25);
    const timer=setTimeout(()=>row.controller.abort(),15_000);let plan:AppDataPlan|undefined,transferred=false;
    try{
      this.active(row);plan=await this.planner!.plan(row.taken.appDataRequest,row.taken.appDataRegistration!,row.controller.signal,()=>this.active(row));this.active(row);
      if(!this.native.prepareOutbox!(row.taken.lease,plan.publication))throw new AppDataPublicationError('app-data-cancelled');
      this.active(row);this.ready(row.taken,plan);transferred=true;
    }catch(error){
      if(this.rows.includes(row)){
        const code=appDataFailure(error);
        try{this.native.failOutbox!(row.taken.lease,code);}
        catch{try{this.native.cancel(row.taken.lease);}catch{/* Keep independent cleanup. */}try{this.native.finish(row.taken.lease);}catch{/* Native expiry is still authoritative. */}}
      }
    }finally{clearInterval(watch);clearTimeout(timer);row.controller.abort();if(plan&&!transferred)this.planner!.release(plan);this.rows=this.rows.filter(value=>value!==row);this.changed();}
  }
  cancel(matches:(origin:ApprovalOrigin)=>boolean):void{
    const removed=this.rows.filter(row=>matches(row.taken.origin));this.rows=this.rows.filter(row=>!matches(row.taken.origin));
    for(const row of removed){row.controller.abort();try{this.native.cancel(row.taken.lease);}catch{/* Continue cleanup. */}try{this.native.finish(row.taken.lease);}catch{/* Native expiry remains authoritative. */}}
    if(removed.length)this.changed();
  }
  refresh():void{this.cancel(origin=>{const row=this.rows.find(value=>value.taken.origin===origin)!;try{return !this.native.isLive(row.taken.lease);}catch{return true;}});}
}
