import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {finalizeEvent,getPublicKey,type NostrEvent} from 'nostr-tools/pure';
import {createNativeApprovalPort,type ApprovalModule} from '../../src/runtime/approval-port.ts';
import {ApprovalService} from '../../src/security/approval-service.ts';
import {createAppDataPlanner} from '../../src/app-data/app-data-plan.ts';
import {deriveAppDataScope,dataTags} from '../../src/app-data/app-data-contract.ts';
import {captureEventSnapshot} from '../../src/security/event-snapshot.ts';
import {deferred} from '../storage/harness.ts';
const key=new Uint8Array(32).fill(42),user=getPublicKey(key),publisher='2'.repeat(64),appId='approval-soy';
const scope=deriveAppDataScope({publisher,kind:35129,identifier:appId}),peers=['wss://one.example.com','wss://two.example.com'];
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function template(id:string){return {kind:30078,created_at:1800000100,tags:dataTags(scope,'levels',id,'example.level',1),content:JSON.stringify({schema:'example.level',version:1,title:id,previous:null,deleted:false,data:{value:1}})};}
function harness(id:string,route:'outbox'|'relay'='outbox',selectedPeers:readonly string[]=peers){
  let network=[...selectedPeers];
  const registration={sessionId:'soy-'+id,generation:'generation-'+id,epoch:1,user,publisher,appId,version:'3'.repeat(64),instanceId:'instance-'+id,fixture:'published',domains:['identity',route],
    appData:{sourceKind:35129,policy:{profile:'soy.app-data/1',scope,maxContentBytes:3072,relays:selectedPeers,defaultRelays:[selectedPeers[0]!]}}};
  let request:Record<string,unknown>={type:route+'.publish',id:'wire-'+id,event:template(id),...(route==='outbox'?{options:{toOutbox:false,relays:selectedPeers}}:{})};
  let claimed=false,live=true,approved=false,events:NostrEvent[]=[],status:'accepted'|'rejected'|'unknown'='accepted';
  let signGate:Promise<void>|null=null,publishGate:Promise<void>|null=null,failFirst=false,malformed=false;
  const calls:string[]=[],responses:unknown[]=[],wires:string[]=[];const origins:string[]=[];
  const module:ApprovalModule={
    takeApproval(){if(claimed)return null;claimed=true;return JSON.stringify({registration,request:JSON.stringify(request)});},
    prepareOutboxApproval(_token,raw){calls.push('prepare-native');const plan=JSON.parse(raw);assert.equal(plan.requestId,request.id);assert.equal(plan.ancillary,null);return true;},
    prepareApprovalSigning(){calls.push('prepare-sign');return true;},
    failOutboxApproval(_token,error){calls.push('fail:'+error);responses.push({type:route+'.publish.result',id:request.id,ok:false,error});live=false;},
    async publishOutboxApproval(_token,group,wire,relay){calls.push('native-publish');assert.equal(group,'primary');wires.push(wire);
      if(failFirst&&relay===selectedPeers[0]+'/')throw Error('lost bridge result');if(publishGate)await publishGate;
      return JSON.stringify({relay,eventId:malformed?'f'.repeat(64):JSON.parse(wire).id,status,reason:''});},
    isApprovalLive:()=>live,mayReviewApproval:()=>live,approveApproval(){calls.push('approve');approved=true;return true;},isApprovalApproved:()=>approved&&live,
    cancelApproval(){calls.push('cancel');live=false;},dismissApproval(){live=false;},resumeApprovals(){},finishApproval(_token,response){calls.push('finish');responses.push(response?JSON.parse(response):null);live=false;},
  };
  const planner=createAppDataPlanner({settings:()=>({networkRelays:network,lookupRelays:selectedPeers}),
    async query(_filters,relays,_signal,active){active();assert.deepEqual(relays,selectedPeers.map(peer=>peer+'/'));calls.push('query');return {events:events.map(event=>({event})),incomplete:false};},
    async publication(value,selected,_signal,active){active();assert.equal(selected,user);assert.equal(route,'outbox');const request=value as {id:string;event:ReturnType<typeof template>};const event=captureEventSnapshot(request.event,user,selectedPeers);
      return {requestId:request.id,event,destinations:event.destinations.map(relay=>({relay,sources:[{kind:'explicit' as const}]})),requiredInboxes:[],ownSource:'skipped',ancillary:null};},
  },()=>1800000100000);
  const service=new ApprovalService(createNativeApprovalPort(module),{assertActive(_origin,domain){origins.push(domain??'relay');assert.equal(domain,route==='outbox'?'outbox':undefined);}},
    {async sign(snapshot){calls.push('sign');if(signGate)await signGate;return clone(finalizeEvent({...clone(snapshot.event),tags:snapshot.event.tags.map(row=>[...row])},key));},async publishEvent(){assert.fail('soy never falls through generic JS Relay transport');}},undefined,undefined,planner);
  service.foreground();service.focus(registration.sessionId);
  return {service,calls,responses,wires,origins,registration,planner,
    enqueue(){return service.enqueue('native-token',selectedPeers,registration);},
    setNetwork(value:readonly string[]){network=[...value];},
    reset(){claimed=false;live=true;approved=false;request={...request,id:'retry-'+id};},
    changeRequest(value:Record<string,unknown>){request=value;},dropContext(){delete (registration as Partial<typeof registration>).appData;},
    setEvents(value:NostrEvent[]){events=value;},setStatus(value:typeof status){status=value;},setSignGate(value:Promise<void>|null){signGate=value;},
    setPublishGate(value:Promise<void>|null){publishGate=value;},failFirst(){failFirst=true;},malformed(){malformed=true;},
  };
}
async function ready(h:ReturnType<typeof harness>){assert(h.enqueue());for(let i=0;i<30;i++){await setImmediate();if(h.service.getSnapshot().current||h.service.getSnapshot().pending===0)return;}assert.fail('preparation did not settle');}
for(const route of ['outbox','relay'] as const)test(`exact ${route} intent uses native prepared/sign/send with actual grant, no ancillary`,async()=>{
  const h=harness('ok-'+route,route);await ready(h);const item=h.service.getSnapshot().current;assert(item?.appData);assert.equal(item.appData.route,route);
  const outcomes=await h.service.approve(item.id);assert.equal(outcomes.length,2);assert(outcomes.every(row=>row.status==='accepted'));
  const response=h.responses[0] as {type:string;id:string;ok:boolean;event:NostrEvent;eventId:string;relays:object};assert.equal(response.type,route+'.publish.result');assert.equal(response.id,'wire-ok-'+route);assert.equal(response.ok,true);assert.equal(response.event.id,response.eventId);
  assert.equal(h.calls.filter(c=>c==='sign').length,1);assert.equal(h.calls.filter(c=>c==='native-publish').length,2);assert(h.calls.indexOf('query')<h.calls.indexOf('prepare-native'));assert.equal(h.calls.filter(c=>c==='query').length,3);
});
test('native Cancel before consent produces no signature or publication',async()=>{const h=harness('cancel');await ready(h);h.service.reject(h.service.getSnapshot().current!.id);assert(!h.calls.includes('sign'));assert(!h.calls.includes('native-publish'));assert.equal(h.service.getSnapshot().pending,0);});
test('required rejected delivery returns ok false with exact signed event and per-relay outcomes',async()=>{
  const h=harness('partial');h.setStatus('rejected');await ready(h);await h.service.approve(h.service.getSnapshot().current!.id);
  const reply=h.responses[0] as {ok:boolean;event:NostrEvent;eventId:string;error:string;relays:Record<string,boolean>};assert.equal(reply.ok,false);assert.equal(reply.event.id,reply.eventId);assert.equal(reply.error,'app-data-publish-incomplete');assert.deepEqual(Object.values(reply.relays),[false,false]);
});
test('unknown bridge outcome keeps exact signed retry, fresh review and one signature',async()=>{
  const h=harness('retry');h.failFirst();await ready(h);await h.service.approve(h.service.getSnapshot().current!.id);
  const reply=h.responses[0] as {event:NostrEvent;eventId:string;error:string;relays:Record<string,boolean>};assert.deepEqual(reply.relays,{[peers[1]+'/']:true});assert.equal(reply.error,'app-data-publication-unknown');assert.equal(reply.event.id,reply.eventId);assert(h.service.hasCloseRisk(h.registration.sessionId));
  h.setEvents([reply.event]);h.reset();await ready(h);await h.service.approve(h.service.getSnapshot().current!.id);
  assert.equal(h.calls.filter(c=>c==='sign').length,1);assert.equal(h.calls.filter(c=>c==='approve').length,2);assert.equal(new Set(h.wires).size,1);
});
test('close during slow signing suppresses stale delivery and retains record until actual unwind',async()=>{
  const h=harness('slow-sign'),gate=deferred();await ready(h);h.setSignGate(gate.promise);const work=h.service.approve(h.service.getSnapshot().current!.id);await setImmediate();h.service.close(h.registration.sessionId);
  const second=harness('slow-sign');await ready(second);assert.equal(second.service.getSnapshot().current,null);assert.equal((second.responses[0] as {error:string}).error,'app-data-busy');assert(!h.calls.includes('native-publish'));
  gate.resolve();await assert.rejects(work,/SIGNER_UNCERTAIN/);second.reset();await ready(second);assert(second.service.getSnapshot().current);second.service.close(second.registration.sessionId);assert.deepEqual(h.responses,[null]);
});
test('first rejected worker cannot release record while another native worker is still unwinding',async()=>{
  const h=harness('drain'),gate=deferred();h.failFirst();h.setPublishGate(gate.promise);await ready(h);let settled=false;
  const work=h.service.approve(h.service.getSnapshot().current!.id).finally(()=>{settled=true;});await setImmediate();assert.equal(settled,false);h.service.close(h.registration.sessionId);
  const second=harness('drain');await ready(second);assert.equal(second.service.getSnapshot().current,null);
  gate.resolve();await assert.rejects(work,/APPROVAL_DENIED/);second.reset();await ready(second);assert(second.service.getSnapshot().current);second.service.close(second.registration.sessionId);
});
test('malformed d-only claim and missing trusted context never fall through generic publication',async()=>{
  const malformed=harness('marker','relay'),event=template('marker');event.tags=event.tags.filter(tag=>tag[0]==='d');malformed.changeRequest({type:'relay.publish',id:'marker',event});await ready(malformed);assert.equal(malformed.service.getSnapshot().current,null);assert(!malformed.calls.includes('sign'));assert(!malformed.calls.includes('prepare-native'));assert.equal((malformed.responses[0] as {error:string}).error,'app-data-invalid-tags');
  const absent=harness('absent','relay');absent.dropContext();await ready(absent);assert.equal(absent.service.getSnapshot().current,null);assert(!absent.calls.includes('sign'));assert(!absent.calls.includes('prepare-native'));
});

test('Network mutation while first four native sends settle blocks later configured-peer dispatch',async()=>{
  const many=Array.from({length:8},(_,i)=>`wss://peer${i}.example.com`),h=harness('settings-send','outbox',many),gate=deferred();h.setPublishGate(gate.promise);await ready(h);
  const work=h.service.approve(h.service.getSnapshot().current!.id);await setImmediate();assert.equal(h.calls.filter(c=>c==='native-publish').length,4);
  h.setNetwork([...many].reverse());gate.resolve();await assert.rejects(work,/app-data-settings-changed/);
  assert.equal(h.calls.filter(c=>c==='native-publish').length,4);assert(h.service.hasCloseRisk(h.registration.sessionId));assert.equal(h.service.getSnapshot().pending,0);
});

test('malformed native outcome after possible dispatch retains signed revision and unknown result',async()=>{
  const h=harness('malformed-outcome');h.malformed();await ready(h);const rows=await h.service.approve(h.service.getSnapshot().current!.id);assert(rows.every(row=>row.status==='unknown'));
  const reply=h.responses[0] as {event:NostrEvent;eventId:string;ok:boolean;error:string};assert.equal(reply.ok,false);assert.equal(reply.event.id,reply.eventId);assert.equal(reply.error,'app-data-publication-unknown');assert(h.service.hasCloseRisk(h.registration.sessionId));
});
