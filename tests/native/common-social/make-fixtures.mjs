import {writeFileSync} from 'node:fs';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {npubEncode} from 'nostr-tools/nip19';
import {createCommonSocialPlanner} from '../../../src/common/social-plan.ts';
import {captureEventSnapshot} from '../../../src/security/event-snapshot.ts';
const key=new Uint8Array(32).fill(3),user=getPublicKey(key),other='4'.repeat(64),relay='wss://relay.damus.io/';
const registration={sessionId:'session',generation:'generation',epoch:1,user,publisher:'2'.repeat(64),appId:'common-test',version:'3'.repeat(64),instanceId:'instance',fixture:'published',domains:['common','identity','outbox'],commonProfile:'social-v1'};
const sign=(kind,tags,content='')=>JSON.parse(JSON.stringify(finalizeEvent({kind,tags,content,created_at:1},key)));
let basis=sign(3,[['p','5'.repeat(64),'wss://hint.example.org','Petname'],['t','keep']],'preserve'),target=sign(30023,[['d','article']],'body');
const planner=createCommonSocialPlanner({async signer(){return true;},async query(filters){return {events:[{event:filters[0].ids?target:basis}],incomplete:false};},async publication(event,id){const snapshot=captureEventSnapshot(event,user,[relay]);return {requestId:id,event:snapshot,destinations:[{relay,sources:[{kind:'network-fallback'}]}],requiredInboxes:[],ownSource:'network-fallback',ancillary:null};}},()=>10000);
const requests=[{type:'common.follow',id:'f',pubkeys:[npubEncode(other)]},{type:'common.unfollow',id:'u',pubkeys:[npubEncode('5'.repeat(64))]},{type:'common.react',id:'r',targetEventId:target.id,reaction:':wave:',customEmojiHref:'https://emoji.example.org/wave.png'},{type:'common.report',id:'e',target:{type:'event',id:target.id},reason:'spam',text:'report text'},{type:'common.report',id:'p',target:{type:'pubkey',pubkey:npubEncode(other)},reason:'other',text:''},{type:'common.follow',id:'noop',pubkeys:[npubEncode('5'.repeat(64))]}];
const cases=[];
for(const request of requests){const plan=await planner.plan(request,registration,new AbortController().signal,()=>{});cases.push({snapshot:JSON.stringify({registration,request:JSON.stringify(request)}),plan:JSON.stringify(plan),noop:!plan.publication});planner.release(plan);}
if(!process.argv[2])throw Error('Explicit output path required');writeFileSync(process.argv[2],JSON.stringify(cases));
