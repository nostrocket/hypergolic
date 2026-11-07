import {text} from '../storage/codec.ts';

export const COMMON_OPERATIONS = Object.freeze(['common.encodeNip19', 'common.decodeNip19',
  'common.getProfile', 'common.follows', 'common.follow', 'common.unfollow', 'common.react', 'common.report'] as const);
export type CommonOperation = typeof COMMON_OPERATIONS[number];
export type CommonRequest = Readonly<{type:'common.encodeNip19';id:string;input:Record<string,unknown>}>
  | Readonly<{type:'common.decodeNip19';id:string;value:string}>
  | Readonly<{type:'common.getProfile';id:string;target:string}>
  | Readonly<{type:'common.follows'|'common.follow'|'common.unfollow'|'common.react'|'common.report';id:string}>;
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
    case 'common.follow': case 'common.unfollow': commonFields(source,['type','id'],['pubkeys']); break;
    case 'common.react': commonFields(source,['type','id'],['targetEventId','reaction','customEmojiHref']); break;
    case 'common.report': commonFields(source,['type','id'],['target','reason','text']); break;
  }
  return Object.freeze({type:type as 'common.follows'|'common.follow'|'common.unfollow'|'common.react'|'common.report',id});
}
export function commonFailure(input:unknown,error = 'unsupported'):CommonReply|null {
  try {
    const source = commonRecord(input);
    if (!COMMON_OPERATIONS.includes(source.type as CommonOperation)) return null;
    return Object.freeze({type:`${source.type}.result`,id:text(source.id,128),ok:false,error,
      ...(source.type === 'common.follows' ? {pubkeys:Object.freeze([])} : {})});
  } catch {return null;}
}
