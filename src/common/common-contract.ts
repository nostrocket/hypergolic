import {text} from '../storage/codec.ts';

export const COMMON_OPERATIONS = Object.freeze(['common.encodeNip19', 'common.decodeNip19',
  'common.getProfile', 'common.follows', 'common.follow', 'common.unfollow', 'common.react', 'common.report'] as const);
export type CommonOperation = typeof COMMON_OPERATIONS[number];
export type CommonRequest = Readonly<{type:'common.encodeNip19';id:string;input:Record<string,unknown>}>
  | Readonly<{type:'common.decodeNip19';id:string;value:string}>
  | Readonly<{type:'common.getProfile';id:string;target:string}>
  | Readonly<{type:'common.follows';id:string}>
  | CommonSocialRequest;
export type CommonSocialRequest = Readonly<{type:'common.follow';id:string;pubkeys:readonly string[]}>
  | Readonly<{type:'common.unfollow';id:string;pubkeys:readonly string[]}>
  | Readonly<{type:'common.react';id:string;targetEventId:string;reaction:string;customEmojiHref?:string}>
  | Readonly<{type:'common.report';id:string;target:Readonly<{type:'event';id:string;pubkey?:string;relay?:string}|{type:'pubkey';pubkey:string;relay?:string}>;reason:string;text:string}>;
export type CommonReply = Readonly<Record<string,unknown> & {type:string;id:string;ok:boolean}>;
export class CommonError extends Error {
  constructor(code = 'unsupported') {super(code);this.name = 'CommonError';}
}
export function commonRecord(value:unknown):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new CommonError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
      Object.values(descriptors).some(field => !Object.hasOwn(field,'value'))) throw new CommonError();
  return value as Record<string,unknown>;
}
export function commonFields(value:Record<string,unknown>, required:readonly string[], optional:readonly string[] = []):void {
  const allowed = new Set([...required,...optional]);
  if (required.some(key => !Object.hasOwn(value,key)) ||
      Object.keys(value).some(key => !allowed.has(key))) throw new CommonError();
}
export function parseCommonRequest(input:unknown):CommonRequest {
  const source = commonRecord(input), type = source.type;
  if (!COMMON_OPERATIONS.includes(type as CommonOperation)) throw new CommonError();
  const id = text(source.id,128);
  switch (type) {
    case 'common.encodeNip19':
      commonFields(source,['type','id','input']);
      return Object.freeze({type,id,input:commonRecord(source.input)});
    case 'common.decodeNip19':
      commonFields(source,['type','id','value']);
      return Object.freeze({type,id,value:text(source.value,5000)});
    case 'common.getProfile':
      commonFields(source,['type','id','target']);
      return Object.freeze({type,id,target:text(source.target,5000)});
    case 'common.follows': commonFields(source,['type','id']); break;
    case 'common.follow': case 'common.unfollow': {
      commonFields(source,['type','id','pubkeys']);
      if (!Array.isArray(source.pubkeys) || Object.getPrototypeOf(source.pubkeys)!==Array.prototype || source.pubkeys.length < 1 || source.pubkeys.length > 16 || Reflect.ownKeys(source.pubkeys).length!==source.pubkeys.length+1 || Array.from({length:source.pubkeys.length},(_,i)=>Object.getOwnPropertyDescriptor(source.pubkeys,String(i))).some(field=>!field||!Object.hasOwn(field,'value'))) throw new CommonError('invalid-pubkey');
      return Object.freeze({type,id,pubkeys:Object.freeze(source.pubkeys.map(value=>text(value,128)))});
    }
    case 'common.react': {
      commonFields(source,['type','id','targetEventId','reaction'],['customEmojiHref']);
      return Object.freeze({type,id,targetEventId:text(source.targetEventId,64),reaction:text(source.reaction,256),
        ...(Object.hasOwn(source,'customEmojiHref') ? {customEmojiHref:text(source.customEmojiHref,2048)} : {})});
    }
    case 'common.report': {
      commonFields(source,['type','id','target','reason','text']);
      const target=commonRecord(source.target);
      if(target.type==='event')commonFields(target,['type','id'],['pubkey','relay']);
      else if(target.type==='pubkey')commonFields(target,['type','pubkey'],['relay']);
      else throw new CommonError('invalid-target');
      return Object.freeze({type,id,target:Object.freeze({type:target.type,...(target.type==='event'?{id:text(target.id,64)}:{pubkey:text(target.pubkey,128)}),...(target.type==='event'&&Object.hasOwn(target,'pubkey')?{pubkey:text(target.pubkey,128)}:{}),...(Object.hasOwn(target,'relay')?{relay:text(target.relay,2048,true)}:{})}) as Extract<CommonSocialRequest,{type:'common.report'}>['target'],
        reason:text(source.reason,32),text:text(source.text,4096,true)});
    }
  }
  return Object.freeze({type:'common.follows',id});
}
export function commonFailure(input:unknown,error = 'unsupported'):CommonReply|null {
  try {
    const source = commonRecord(input);
    if (!COMMON_OPERATIONS.includes(source.type as CommonOperation)) return null;
    return Object.freeze({type:`${source.type}.result`,id:text(source.id,128),ok:false,error,
      ...(source.type === 'common.follows' ? {pubkeys:Object.freeze([])} : {})});
  } catch {return null;}
}
