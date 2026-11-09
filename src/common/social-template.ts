import {nip19} from 'nostr-tools';
import type {NostrEvent} from 'nostr-tools/pure';
import {publicKey} from '../storage/codec.ts';
import type {UnsignedEventTemplate} from '../security/event-snapshot.ts';
import {CommonError,type CommonSocialRequest} from './common-contract.ts';
export const COMMON_SOCIAL_PROFILE='social-v1';
export function socialPubkey(value:unknown,npubOnly=false):string {
  if(typeof value!=='string')throw new CommonError('invalid-pubkey');
  if(!npubOnly && /^[0-9a-f]{64}$/.test(value))return publicKey(value);
  try{const decoded=nip19.decode(value);if(decoded.type==='npub')return publicKey(decoded.data);}catch{/* Bound caller text already parsed. */}
  throw new CommonError('invalid-pubkey');
}
function reaction(request:Extract<CommonSocialRequest,{type:'common.react'}>):readonly string[]|null{
  const value=request.reaction,shortcode=/^:([A-Za-z0-9_-]{1,64}):$/.exec(value);
  if(shortcode){
    if(!request.customEmojiHref)throw new CommonError('invalid-reaction');
    try{const url=new URL(request.customEmojiHref);if(url.protocol!=='https:'||!url.hostname||url.username||url.password)throw new CommonError('invalid-reaction');}catch{throw new CommonError('invalid-reaction');}
    return Object.freeze(['emoji',shortcode[1]!,request.customEmojiHref]);
  }
  if(request.customEmojiHref!==undefined)throw new CommonError('invalid-reaction');
  if(value==='+'||value==='-')return null;
  if(!/^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u.test(value))throw new CommonError('invalid-reaction');
  return null;
}
export function validateCommonSocialIntent(request:CommonSocialRequest):void{
  if(request.type==='common.follow'||request.type==='common.unfollow'){for(const key of request.pubkeys)socialPubkey(key,true);return;}
  if(request.type==='common.react'){if(!/^[0-9a-f]{64}$/.test(request.targetEventId))throw new CommonError('invalid-target');reaction(request);return;}
  if(!['nudity','malware','profanity','illegal','spam','impersonation','other'].includes(request.reason))throw new CommonError('invalid-report-reason');
  if(request.target.type==='pubkey')socialPubkey(request.target.pubkey);
  else{if(!/^[0-9a-f]{64}$/.test(request.target.id))throw new CommonError('invalid-target');if(request.target.pubkey!==undefined)socialPubkey(request.target.pubkey);}
}
export function deriveCommonSocial(request:CommonSocialRequest,basis:NostrEvent|null,target:NostrEvent|null,created_at:number):UnsignedEventTemplate|null{
  if(request.type==='common.follow'||request.type==='common.unfollow'){
    const targets=new Set(request.pubkeys.map(value=>socialPubkey(value,true))),remove=request.type==='common.unfollow';
    const before=basis?.tags??[],tags:string[][]=[];
    for(const tag of before)if(!(remove&&tag[0]==='p'&&targets.has(tag[1]!)))tags.push([...tag]);
    if(!remove){const existing=new Set<string>();for(const tag of tags)if(tag[0]==='p'&&tag[1])existing.add(tag[1]);for(const key of targets)if(!existing.has(key)){tags.push(['p',key]);existing.add(key);}}
    if(JSON.stringify(before)===JSON.stringify(tags))return null;
    return {kind:3,content:basis?.content??'',tags,created_at};
  }
  if(request.type==='common.react'){
    if(!target||target.id!==request.targetEventId)throw new CommonError('author-unresolved');
    const tags=[['e',target.id],['p',target.pubkey]],emoji=reaction(request);
    if(target.kind>=30000&&target.kind<40000){const d=target.tags.find(tag=>tag[0]==='d')?.[1]??'';tags.push(['a',`${target.kind}:${target.pubkey}:${d}`]);}
    if(emoji)tags.push([...emoji]);return {kind:7,content:request.reaction,tags,created_at};
  }
  if(!['nudity','malware','profanity','illegal','spam','impersonation','other'].includes(request.reason))throw new CommonError('invalid-report-reason');
  if(request.target.type==='pubkey')return {kind:1984,content:request.text,tags:[['p',socialPubkey(request.target.pubkey),request.reason]],created_at};
  if(!target||target.id!==request.target.id||request.target.pubkey!==undefined&&socialPubkey(request.target.pubkey)!==target.pubkey)throw new CommonError('author-unresolved');
  return {kind:1984,content:request.text,tags:[['e',target.id,request.reason],['p',target.pubkey]],created_at};
}
