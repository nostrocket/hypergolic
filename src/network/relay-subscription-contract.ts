import type { NostrEvent } from 'nostr-tools/pure';
import { parseQueryFilters, type QueryFilter, QUERY_LIMITS } from './relay-query-contract.ts';
import { utf8Bytes } from '../storage/codec.ts';
import { normalizeRelayUrl } from './relay-settings.ts';

export const SUBSCRIPTION_LIMITS = Object.freeze({ process:8, session:2, sessions:64,
  relays:2, requestBytes:QUERY_LIMITS.requestBytes, dedupe:1024, callerIds:4096,
  framesPerSecond:64, retries:5, retryMs:Object.freeze([1000,2000,4000,8000,16000]) });
export type RelaySubscribeRequest = Readonly<{type:'relay.subscribe';id:string;subId:string;filters:readonly QueryFilter[];relay?:string}>;
export type RelayCloseRequest = Readonly<{type:'relay.close';id:string;subId:string}>;
export type RelaySubscriptionMessage = Readonly<{type:'relay.event';subId:string;result:Readonly<{event:NostrEvent;sidecar?:Readonly<{relayHints:readonly string[]}>}>}>
  | Readonly<{type:'relay.eose';subId:string}> | Readonly<{type:'relay.closed';subId:string;reason?:string}>;
export class RelaySubscriptionError extends Error {
  constructor(message='relay subscription unavailable'){super(message);this.name='RelaySubscriptionError';}
}
const fail=():never=>{throw new RelaySubscriptionError('invalid relay subscription');};
function record(input:unknown):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)return fail();
  const fields=Object.getOwnPropertyDescriptors(input);
  if(Reflect.ownKeys(input).length!==Object.keys(fields).length||Object.values(fields).some(field=>!Object.prototype.hasOwnProperty.call(field,'value')))return fail();
  return input as Record<string,unknown>;
}
function identifier(value:unknown):string {
  if(typeof value!=='string'||utf8Bytes(value)<1||utf8Bytes(value)>128||/[\u0000-\u001f\u007f]/.test(value))return fail();
  return value;
}
export function parseRelaySubscribe(input:unknown):RelaySubscribeRequest {
  const data=record(input);
  if(data.type!=='relay.subscribe'||Object.keys(data).some(key=>!['type','id','subId','filters','relay'].includes(key)))return fail();
  const id=identifier(data.id),subId=identifier(data.subId),filters=parseQueryFilters(data.filters);
  if(filters.some(filter=>Array.isArray(filter.kinds)&&filter.kinds.some(kind=>kind===4||kind===1059)))throw new RelaySubscriptionError('encrypted subscriptions unsupported');
  const relay=data.relay===undefined?undefined:normalizeRelayUrl(identifierRelay(data.relay));
  const request=Object.freeze({type:'relay.subscribe' as const,id,subId,filters,...(relay===undefined?{}:{relay})});
  if(utf8Bytes(JSON.stringify(request))>SUBSCRIPTION_LIMITS.requestBytes)return fail();
  return request;
}
function identifierRelay(value:unknown):string {if(typeof value!=='string'||utf8Bytes(value)>2048)return fail();return value;}
export function parseRelayClose(input:unknown):RelayCloseRequest {
  const data=record(input);
  if(data.type!=='relay.close'||Object.keys(data).length!==3||Object.keys(data).some(key=>!['type','id','subId'].includes(key)))return fail();
  return Object.freeze({type:'relay.close',id:identifier(data.id),subId:identifier(data.subId)});
}
