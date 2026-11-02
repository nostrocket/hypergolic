import {text, utf8Bytes} from '../storage/codec.ts';
import {parseOutboxQuery, outboxRecord, OutboxQueryError, type OutboxQueryRequest} from './query-contract.ts';
import type {OutboxEventRow} from './read-service.ts';
export type OutboxSubscribeRequest = Readonly<Omit<OutboxQueryRequest,'type'> & {type:'outbox.subscribe';subId:string}>;
export type OutboxCloseRequest = Readonly<{type:'outbox.close';id:string;subId:string}>;
/** relay.eose is private native backplane completion, consumed before guest delivery. */
export type OutboxSubscriptionMessage = Readonly<{type:'outbox.event';subId:string;result:OutboxEventRow}>
  | Readonly<{type:'outbox.closed';subId:string;reason?:string}> | Readonly<{type:'relay.eose';subId:string}>;
function correlation(value:unknown):string {
  const result=text(value,128);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new OutboxQueryError();
  return result;
}
export function parseOutboxSubscribe(input:unknown):OutboxSubscribeRequest {
  try {
    const source=outboxRecord(input);
    if(source.type!=='outbox.subscribe'||Object.keys(source).some(key=>!['type','id','subId','filters','options'].includes(key)))throw new OutboxQueryError();
    const subId=correlation(source.subId),id=correlation(source.id);
    const query=parseOutboxQuery({type:'outbox.query',id,filters:source.filters,...(Object.hasOwn(source,'options')?{options:source.options}:{})});
    if(query.filters.some(filter=>Array.isArray(filter.kinds)&&filter.kinds.some(kind=>kind===4||kind===1059)))throw new OutboxQueryError('policy denied');
    const result=Object.freeze({...query,type:'outbox.subscribe' as const,subId});
    if(utf8Bytes(JSON.stringify(result))>16*1024)throw new OutboxQueryError();
    return result;
  } catch {throw new OutboxQueryError();}
}
export function parseOutboxClose(input:unknown):OutboxCloseRequest {
  const source=outboxRecord(input);
  if(source.type!=='outbox.close'||Object.keys(source).length!==3||Object.keys(source).some(key=>!['type','id','subId'].includes(key)))throw new OutboxQueryError();
  return Object.freeze({type:'outbox.close',id:correlation(source.id),subId:correlation(source.subId)});
}
