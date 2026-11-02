import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {ApprovalService,type NativeTakenApproval,type NativeApprovalLease,type NativeApprovalLeasePort,type ApprovalOrigin} from '../../src/security/approval-service.ts';
import {createOutboxPublicationPlanner,type OutboxPublicationPlan} from '../../src/outbox/publication-plan.ts';
import {parseOutboxPublish} from '../../src/outbox/publication-contract.ts';
import {parseOutboxRelayList} from '../../src/outbox/relay-list.ts';
import type {OutboxAuthorResolver} from '../../src/outbox/author-resolver.ts';
import type {RelayOutcome} from '../../src/network/relay-service.ts';
const secret=new Uint8Array(32).fill(37),recipientSecret=new Uint8Array(32).fill(38),user=getPublicKey(secret),recipient=getPublicKey(recipientSecret);
const template={kind:1,created_at:2,tags:[],content:'exact review'};
const own=parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,tags:[['r','wss://own.nostr.net','write']],content:''},secret))),user);
const inbox=parseOutboxRelayList(JSON.parse(JSON.stringify(finalizeEvent({kind:10002,created_at:1,tags:[['r','wss://inbox.nostr.net','read']],content:''},recipientSecret))),recipient);
const origin=(sessionId:string):ApprovalOrigin=>({sessionId,generation:sessionId,epoch:1,user,publisher:'a'.repeat(64),appId:'fixture',version:'b'.repeat(64),instanceId:sessionId});
const sign=(event:any)=>JSON.parse(JSON.stringify(finalizeEvent({...event,tags:event.tags.map((tag:string[])=>[...tag])},secret)));
class Native implements NativeApprovalLeasePort {
 states=new Map<NativeApprovalLease,{live:boolean;approved:boolean;plan?:OutboxPublicationPlan}>();requests=new Map<string,NativeTakenApproval>();responses:(string|null)[]=[];sent:{group:string;event:any;relays:readonly string[]}[]=[];allowPrepare=true;
 primary:RelayOutcome['status']='accepted';ancillary:RelayOutcome['status']='rejected';malformed=false;ancillaryFailure=false;
 issue(token:string,options:unknown={toInboxes:[recipient]}){const lease={},request=parseOutboxPublish({type:'outbox.publish',id:token,event:template,options},user);this.states.set(lease,{live:true,approved:false});this.requests.set(token,{lease,origin:origin(token),requestId:token,event:request.event,outboxRequest:request});return lease;}
 state(lease:NativeApprovalLease){return this.states.get(lease)!;}
 take(token:string){const taken=this.requests.get(token)??null;this.requests.delete(token);return taken;}
 isLive(lease:NativeApprovalLease){return this.state(lease).live;}
 mayReview(lease:NativeApprovalLease){const row=this.state(lease);return row.live&&!row.approved&&!!row.plan;}
 prepareOutbox(lease:NativeApprovalLease,plan:OutboxPublicationPlan){if(!this.allowPrepare)return false;this.state(lease).plan=plan;return true;}
 failOutbox(lease:NativeApprovalLease,error:string){this.state(lease).live=false;this.responses.push(JSON.stringify({type:'outbox.publish.result',ok:false,error}));}
 approveOnce(lease:NativeApprovalLease){if(!this.mayReview(lease))return false;this.state(lease).approved=true;return true;}
 isApproved(lease:NativeApprovalLease){const row=this.state(lease);return row.live&&row.approved;}
 cancel(lease:NativeApprovalLease){this.state(lease).live=false;}
 dismiss(lease:NativeApprovalLease){this.cancel(lease);}
 resume(){}
 finish(lease:NativeApprovalLease,response:string|null=null){this.state(lease).live=false;this.responses.push(response);}
 async publishOutbox(_lease:NativeApprovalLease,group:'primary'|'relay-list',event:any,relays:readonly string[]){this.sent.push({group,event,relays});if(group==='relay-list'&&this.ancillaryFailure)throw Error('native bridge failed');return relays.map(relay=>({relay,eventId:this.malformed?'wrong':event.id,status:group==='relay-list'?this.ancillary:relay.includes('inbox')?this.primary:'accepted' as const,reason:''}));}
}
function harness(resolve:OutboxAuthorResolver['resolve']=async(_user,author)=>({list:author===user?own:inbox,source:'cache',incomplete:false})){
 const native=new Native();let signs=0;const discoveries:string[]=[];
 const planner=createOutboxPublicationPlanner({async resolve(...args){discoveries.push(args[1]);return resolve(...args);}},()=>({networkRelays:['wss://fallback.nostr.net'],lookupRelays:['wss://lookup.nostr.net']}),{ancillaryWhenOutboxSkipped:'omit'});
 const service=new ApprovalService(native,{assertActive(_origin,domain){assert.equal(domain,'outbox');}},{async sign(snapshot){signs++;return sign(snapshot.event);},async publishEvent(){throw Error('Outbox used legacy JS publisher');}},planner);
 return {native,service,discoveries,signs:()=>signs};
}
async function settled(h:ReturnType<typeof harness>,token='one'){
 h.service.enqueue(token,[]);h.service.focus(token);for(let i=0;i<20&&!h.service.getSnapshot().current&&h.service.getSnapshot().pending;i++)await new Promise(resolve=>setTimeout(resolve,1));return h.service.getSnapshot().current;
}
test('required inbox ACKs govern primary success while ancillary failure remains independent and only one signature is produced',async()=>{
 const h=harness();h.native.issue('one');const item=await settled(h);assert.ok(item?.outbox);assert.deepEqual(item.outbox.ancillary,own.event);assert.equal(h.signs(),0);assert.equal(h.native.sent.length,0);
 const rows=await h.service.approve(item.id),receipt=h.service.outboxReceipt(rows)!;assert.equal(h.signs(),1);assert.equal(h.native.sent.length,2);assert.equal(receipt.primary.ok,true);assert.equal(receipt.ancillary?.outcomes[0]?.status,'rejected');
 assert.equal(h.native.sent[1]?.event.id,own.event.id);assert.deepEqual(h.native.sent[0]?.relays,h.native.sent[1]?.relays);assert.equal(JSON.parse(h.native.responses[0]!).ok,true);await assert.rejects(h.service.approve(item.id));
});
test('unknown required inbox stays unknown, has no false rejection in the wire map and cannot be satisfied by own acceptance',async()=>{
 const h=harness();h.native.primary='unknown';h.native.issue('one');const item=await settled(h),rows=await h.service.approve(item!.id),receipt=h.service.outboxReceipt(rows)!;
 assert.equal(receipt.primary.ok,false);assert.equal(receipt.primary.outcomes[1]?.status,'unknown');assert.equal(receipt.response.error,'publication result unknown');assert.deepEqual(receipt.response.relays,{'wss://own.nostr.net/':true});assert.equal(receipt.response.event,undefined);
});
test('rejected required inbox is a known failure even if an unrelated own relay accepted',async()=>{
 const h=harness();h.native.primary='rejected';h.native.issue('one');const item=await settled(h),rows=await h.service.approve(item!.id),receipt=h.service.outboxReceipt(rows)!;
 assert.equal(receipt.primary.ok,false);assert.equal(receipt.response.relays['wss://inbox.nostr.net/'],false);assert.equal(receipt.response.error,'required inbox relay did not accept the event');
});
test('explicit-only opt-out skips own lookup/ancillary and sends just the reviewed primary event',async()=>{
 const h=harness();h.native.issue('one',{toOutbox:false,relays:['wss://explicit.nostr.net']});const item=await settled(h);assert.equal(item?.outbox?.ancillary,null);assert.equal(h.discoveries.length,0);
 const rows=await h.service.approve(item!.id);assert.equal(h.native.sent.length,1);assert.equal(h.signs(),1);assert.equal(h.service.outboxReceipt(rows)?.primary.ok,true);
});
test('missing required inbox finishes with finite error without review, signing or transport',async()=>{
 const h=harness(async(_u,author)=>{if(author!==user)throw Error('offline');return {list:own,source:'cache',incomplete:false};});h.native.issue('one');assert.equal(await settled(h),null);assert.equal(h.service.getSnapshot().pending,0);assert.equal(h.signs(),0);assert.equal(h.native.sent.length,0);assert.equal(JSON.parse(h.native.responses[0]!).error,'required inbox unavailable');
});
test('native prepare refusal never enables review or signing',async()=>{
 const h=harness();h.native.allowPrepare=false;h.native.issue('one');assert.equal(await settled(h),null);assert.equal(h.signs(),0);assert.equal(h.native.sent.length,0);
});
test('background, close and revision revoke unresolved preparation before late routing can create review',async()=>{
 for(const action of ['background','close','revision'] as const){let finish!:()=>void;const h=harness(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {list:own,source:'cache',incomplete:false};});h.native.issue('one',{});h.service.enqueue('one',[]);h.service.focus('one');assert.equal(h.service.getSnapshot().pending,1);
 if(action==='background')h.service.background();else if(action==='close')h.service.close('one');else h.service.revisionChanged(2);finish();await new Promise(resolve=>setTimeout(resolve,1));assert.equal(h.service.getSnapshot().pending,0);assert.equal(h.service.getSnapshot().current,null);assert.equal(h.signs(),0);assert.equal(h.native.sent.length,0);}
});
test('native lease expiry during discovery cancels preparation and suppresses late review',async()=>{
 let finish!:()=>void;const h=harness(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {list:own,source:'cache',incomplete:false};}),lease=h.native.issue('one',{});h.service.enqueue('one',[]);h.native.state(lease).live=false;await new Promise(resolve=>setTimeout(resolve,35));finish();await new Promise(resolve=>setTimeout(resolve,1));assert.equal(h.service.getSnapshot().pending,0);assert.equal(h.signs(),0);
});
test('malformed primary native receipts stop ancillary publication and deny result delivery',async()=>{
 const h=harness();h.native.malformed=true;h.native.issue('one');const item=await settled(h);await assert.rejects(h.service.approve(item!.id));assert.equal(h.native.sent.length,1);assert.equal(h.native.responses[0],null);
});
test('native bridge hooks are mandatory; no legacy JS transport fallback is permitted',()=>{
 const h=harness();h.native.issue('one');h.native.prepareOutbox=undefined as any;assert.equal(h.service.enqueue('one',[]),false);assert.equal(h.service.getSnapshot().pending,0);assert.equal(h.signs(),0);assert.equal(h.native.sent.length,0);
});

test('ancillary bridge failure preserves primary ACKs and records uncertain list receipts without retrying',async()=>{
 const h=harness();h.native.ancillaryFailure=true;h.native.issue('one');const item=await settled(h),rows=await h.service.approve(item!.id),receipt=h.service.outboxReceipt(rows)!;
 assert.equal(receipt.primary.ok,true);assert.equal(JSON.parse(h.native.responses[0]!).ok,true);assert.equal(h.signs(),1);assert.equal(h.native.sent.length,2);assert.ok(receipt.ancillary?.outcomes.every(row=>row.status==='unknown'));
});
