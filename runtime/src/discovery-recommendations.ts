import {verifyEvent} from 'nostr-tools/pure';
import type {NappletMessage} from '@kehto/runtime';
import type {createNativeClient} from './native-client';
import {normalizeRelayUrl} from '../../src/network/relay-settings';

export const RECOMMENDATION = 'relay.catalogRecommendation';
const hex = /^[0-9a-f]{64}$/;
const terminal = new Set(['already-recommended','cancelled','stale','account-changed','read-only','unavailable','uncertain','failed']);
function record(value:unknown): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid recommendation');
  return value as Record<string,unknown>;
}
function requestFields(value:unknown) {
  const row=record(value);
  if(Object.keys(row).length!==3||typeof row.account!=='string'||!hex.test(row.account)||
    row.revision!==null&&(typeof row.revision!=='string'||!hex.test(row.revision))||
    typeof row.coordinate!=='string'||row.coordinate.length>512||!/^35129:[0-9a-f]{64}:.+$/u.test(row.coordinate)||/[\u0000-\u001f\u007f]/.test(row.coordinate))throw Error('Invalid recommendation');
  return {account:row.account,revision:row.revision as string|null,coordinate:row.coordinate};
}
export function captureRecommendationRead(value:unknown) {
  const row=record(value);
  if(['read-only','unavailable','incomplete'].includes(String(row.status))&&Object.keys(row).length===1)return {status:row.status};
  if(row.status!=='ready'||Object.keys(row).length!==4||typeof row.account!=='string'||!hex.test(row.account)||
    row.revision!==null&&(typeof row.revision!=='string'||!hex.test(row.revision))||!Array.isArray(row.recommended)||row.recommended.length>512||
    !row.recommended.every(item=>typeof item==='string'&&item.length<=512))throw Error('Invalid list');
  return {status:'ready',account:row.account,revision:row.revision,recommended:[...row.recommended]};
}
function prepared(value:unknown,coordinate:string) {
  const row=record(value),event=record(row.event);
  if(row.status!=='prepared'||Object.keys(row).length!==3||Object.keys(event).length!==4||event.kind!==30267||
    !Number.isSafeInteger(event.created_at)||Number(event.created_at)<0||typeof event.content!=='string'||
    !Array.isArray(event.tags)||event.tags.length>512||!event.tags.every(tag=>Array.isArray(tag)&&tag.length<=256&&tag.every(field=>typeof field==='string'))||
    JSON.stringify(event).length>65536||new TextEncoder().encode(JSON.stringify(event)).length>65536)throw Error('Invalid preparation');
  const tags=event.tags as string[][];
  if(tags.filter(tag=>tag[0]==='d').length!==1||!tags.some(tag=>tag.length===2&&tag[0]==='d'&&tag[1]==='napplets')||
    !tags.some(tag=>tag[0]==='a'&&tag[1]===coordinate))throw Error('Invalid list target');
  if(!Array.isArray(row.relays)||!row.relays.length||row.relays.length>16||!row.relays.every(relay=>typeof relay==='string'&&relay.length<=512))throw Error('Invalid destinations');
  const rawRelays=row.relays as string[];
  const relays=rawRelays.map(normalizeRelayUrl);
  if(new Set(relays).size!==relays.length)throw Error('Invalid destinations');
  return {event:JSON.parse(JSON.stringify(event)),relays};
}

export const recommendationsPrelude = `
    const recommendations = (() => {
      const type = '${RECOMMENDATION}';
      let pending;
      window.addEventListener('message', event => {
        const data = event.data;
        if (!pending || !event.isTrusted || event.source !== parent || data?.type !== type + '.result' || data.id !== pending.id || Object.keys(data).length !== 3) return;
        const reply = pending; pending = undefined; clearTimeout(reply.timer);
        reply.resolve(data.result);
      });
      const call = request => {
        if (pending) return Promise.resolve({status:'unavailable'});
        return new Promise(resolve => {
          const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
          const timer = setTimeout(() => {pending = undefined; resolve({status:'uncertain'});}, 690000);
          pending = {id,timer,resolve};
          parent.postMessage({type,id,token,...request}, '*');
        });
      };
      return Object.freeze({version:1,read:()=>call({}),recommend:request=>call({request})});
    })();
`;

export function createRecommendationsReceiver(source:Window,native:ReturnType<typeof createNativeClient>,token:string,live:()=>boolean) {
  let pending=false;
  return (value:unknown):void=>{
    if(!live())return;
    let row:Record<string,unknown>;
    try{row=record(value);}catch{return;}
    if(row.type!==RECOMMENDATION||row.token!==token||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.id)||
      Object.keys(row).length!==(row.request===undefined?3:4))return;
    const id=row.id;
    const send=(result:unknown)=>{if(live())source.postMessage({type:RECOMMENDATION+'.result',id,result},'*');};
    if(pending){send({status:'unavailable'});return;}
    let request:ReturnType<typeof requestFields>|undefined;
    try{if(row.request!==undefined)request=requestFields(row.request);}catch{send({status:'unavailable'});return;}
    pending=true;
    void(async()=>{
      const response=await native.request({type:RECOMMENDATION,id:'recommendation-'+crypto.randomUUID(),...request} as NappletMessage,undefined,26_000);
      if(!live())return;
      const result='result'in response?response.result:undefined;
      if(!request){send(captureRecommendationRead(result));return;}
      const reply=record(result);
      if(terminal.has(String(reply.status))&&Object.keys(reply).length===1){send(reply);return;}
      const plan=prepared(result,request.coordinate);
      if(!live())return;
      const receipt=record(await native.request({type:'relay.publish',id:'recommendation-publish-'+crypto.randomUUID(),event:plan.event} as NappletMessage,undefined,660_000));
      if(!live())return;
      if(receipt.ok===false&&receipt.error==='no relay accepted the event'){send({status:'failed'});return;}
      const event=record(receipt.event);
      if(receipt.ok===true&&receipt.eventId===event.id&&event.pubkey===request.account&&event.kind===plan.event.kind&&
        event.created_at===plan.event.created_at&&event.content===plan.event.content&&JSON.stringify(event.tags)===JSON.stringify(plan.event.tags)&&verifyEvent(event as never))send({status:'published'});
      else send({status:'uncertain'});
    })().catch(()=>send({status:request?'uncertain':'incomplete'})).finally(()=>{pending=false;});
  };
}
