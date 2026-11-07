import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {npubEncode} from 'nostr-tools/nip19';
import {createNativeApprovalPort,type ApprovalModule} from '../../src/runtime/approval-port.ts';
import {ApprovalService} from '../../src/security/approval-service.ts';
import {createCommonSocialPlanner} from '../../src/common/social-plan.ts';
import {captureEventSnapshot} from '../../src/security/event-snapshot.ts';
const key=new Uint8Array(32).fill(3),user=getPublicKey(key),other='4'.repeat(64),relay='wss://relay.damus.io/';
const registration={sessionId:'published-session',generation:'generation',epoch:1,user,publisher:'2'.repeat(64),appId:'common-test',version:'3'.repeat(64),instanceId:'instance',fixture:'published',domains:['common','identity','outbox'],commonProfile:'social-v1' as const};
function harness(noop=false,unknown=false,preparationFailure=false){
  const request={type:'common.follow',id:'original-id',pubkeys:[npubEncode(other)]};
  let basis=noop?JSON.parse(JSON.stringify(finalizeEvent({kind:3,created_at:1,tags:[['p',other]],content:'keep'},key))):null;
  let claimed=false,live=true,approved=false;const calls:string[]=[],responses:unknown[]=[];
  const module:ApprovalModule={
    takeApproval(){if(claimed)return null;claimed=true;return JSON.stringify({registration,request:JSON.stringify(request)});},
    prepareCommonApproval(_token,raw){calls.push('prepare-common');assert.equal(JSON.parse(raw).request.type,'common.follow');return true;},
    completeCommonNoop(){calls.push('noop');live=false;return true;},failCommonApproval(_token,error){calls.push('fail:'+error);if(preparationFailure)throw Error('native bridge closed');live=false;},
    prepareApprovalSigning(){calls.push('prepare-signing');return true;},
    async publishOutboxApproval(_token,group,wire,destination){calls.push('publish');if(unknown)throw Error('bridge result lost');assert.equal(group,'primary');const event=JSON.parse(wire);return JSON.stringify({relay:destination,eventId:event.id,status:'accepted',reason:''});},
    isApprovalLive:()=>live,mayReviewApproval:()=>live,approveApproval(){calls.push('approve');approved=true;return true;},isApprovalApproved:()=>approved,
    cancelApproval(){calls.push('cancel');live=false;},dismissApproval(){live=false;},resumeApprovals(){},finishApproval(_token,response){calls.push('finish');responses.push(response?JSON.parse(response):null);live=false;},
  };
  const planner=createCommonSocialPlanner({async signer(){return true;},async query(){if(preparationFailure)throw Error('read failed');return {events:basis?[{event:basis}]:[],incomplete:false};},
    async publication(event,id){const captured=captureEventSnapshot(event,user,[relay]);return {requestId:id,event:captured,destinations:[{relay,sources:[{kind:'network-fallback'}]}],requiredInboxes:[],ownSource:'network-fallback',ancillary:null};}},()=>2000);
  const service=new ApprovalService(createNativeApprovalPort(module),{assertActive(_origin,domain){assert.equal(domain,'common');}},
    {async sign(snapshot){calls.push('sign');return JSON.parse(JSON.stringify(finalizeEvent({...snapshot.event,tags:snapshot.event.tags.map(row=>[...row])},key)));},async publishEvent(){assert.fail('Common cannot fall into unbound generic Relay publication');}},undefined,planner);
  service.foreground();service.focus(registration.sessionId);
  return {service,calls,responses,change(){basis=JSON.parse(JSON.stringify(finalizeEvent({kind:3,created_at:2,tags:[['p','5'.repeat(64)]],content:''},key)));}};
}
async function prepared(h:ReturnType<typeof harness>){assert(h.service.enqueue('private-native-token',[relay],registration));for(let i=0;i<20;i++){await setImmediate();if(h.service.getSnapshot().current||h.service.getSnapshot().pending===0)return;}assert.fail('Preparation did not settle');}
test('original Common intent reaches exact review/sign/native-send and returns original Common correlation',async()=>{
  const h=harness();await prepared(h);const item=h.service.getSnapshot().current;assert(item?.common);assert.equal(item.event.event.kind,3);
  const outcomes=await h.service.approve(item.id);assert.equal(outcomes[0]?.status,'accepted');
  assert.deepEqual(h.calls,['prepare-common','prepare-signing','approve','sign','publish','finish']);
  const reply=h.responses[0] as Record<string,unknown>;assert.equal(reply.type,'common.follow.result');assert.equal(reply.id,'original-id');assert.equal(reply.ok,true);assert.ok(reply.eventId);
});
test('idempotent complete basis ends through dedicated no-op lane without review/approval/sign/send',async()=>{
  const h=harness(true);await prepared(h);assert.equal(h.service.getSnapshot().current,null);assert.equal(h.service.getSnapshot().pending,0);assert.deepEqual(h.calls,['noop']);
});
test('fresh changed basis cancels before native approve/sign and returns a clear correlated failure',async()=>{
  const h=harness();await prepared(h);const item=h.service.getSnapshot().current!;h.change();
  await assert.rejects(h.service.approve(item.id),/follow-list-changed/);assert(h.calls.includes('fail:follow-list-changed'));assert(!h.calls.includes('approve'));assert(!h.calls.includes('sign'));assert(!h.calls.includes('publish'));assert.equal(h.service.getSnapshot().pending,0);
});
test('close before approval revokes and releases prepared Common ownership with no public effects',async()=>{
  const h=harness();await prepared(h);h.service.close(registration.sessionId);assert.equal(h.service.getSnapshot().pending,0);assert(h.calls.includes('cancel'));assert(!h.calls.includes('approve'));assert(!h.calls.includes('sign'));assert(!h.calls.includes('publish'));
});


test('a lost native publication result remains unknown and retains close risk, never a false known failure',async()=>{
  const h=harness(false,true);await prepared(h);const item=h.service.getSnapshot().current!;const outcomes=await h.service.approve(item.id);
  assert.equal(outcomes[0]?.status,'unknown');assert.equal((h.responses[0] as Record<string,unknown>).error,'publication-result-unknown');assert.equal(h.service.hasCloseRisk(registration.sessionId),true);assert.equal(h.calls.filter(value=>value==='publish').length,1);
});


test('preparation failure plus throwing native reporter still cancels/finishes captured token and releases UI ownership',async()=>{
  const h=harness(false,false,true);await prepared(h);assert.equal(h.service.getSnapshot().pending,0);assert.equal(h.service.getSnapshot().current,null);
  assert.deepEqual(h.calls,['fail:relay-timeout','cancel','finish']);assert(!h.calls.includes('approve'));assert(!h.calls.includes('sign'));assert(!h.calls.includes('publish'));
});
