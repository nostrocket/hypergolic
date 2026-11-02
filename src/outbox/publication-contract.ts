import {captureUnsignedEventTemplate, type UnsignedEventTemplate} from '../security/event-snapshot.ts';
import {normalizeRelayUrl} from '../network/relay-settings.ts';
import {publicKey, text, utf8Bytes} from '../storage/codec.ts';
import {OUTBOX_LIST_LIMITS} from './relay-list.ts';
import {outboxList, outboxRecord} from './query-contract.ts';

export class OutboxPublicationError extends Error {
  constructor(message = 'invalid publication') {super(message); this.name = 'OutboxPublicationError';}
}
// Native WSS frame limit.
export const OUTBOX_EVENT_FRAME_BYTES=8192;
export function assertOutboxEventFrameFits(event:UnsignedEventTemplate,user:string):void{
  const signed={kind:event.kind,content:event.content,tags:event.tags,created_at:event.created_at,id:'0'.repeat(64),pubkey:user,sig:'0'.repeat(128)};
  if(utf8Bytes(JSON.stringify(['EVENT',signed]))>OUTBOX_EVENT_FRAME_BYTES)throw new OutboxPublicationError('publication frame too large');
}
export type OutboxPublishRequest = Readonly<{type:'outbox.publish'; id:string; event:UnsignedEventTemplate;
  options:Readonly<{toOutbox:boolean; toInboxes:readonly string[]; relays:readonly string[]}>}>;
/** The selected identity is an app-owned input, never a guest option. */
export function parseOutboxPublish(input:unknown, user:string):OutboxPublishRequest {
  try {
    const value=outboxRecord(input);
    if(value.type!=='outbox.publish' || !Object.hasOwn(value,'event') || Object.keys(value).some(key=>!['type','id','event','options'].includes(key)))throw new OutboxPublicationError();
    const options=Object.hasOwn(value,'options') ? outboxRecord(value.options) : {};
    if(Object.keys(options).some(key=>!['toOutbox','toInboxes','relays'].includes(key)) || (Object.hasOwn(options,'toOutbox')&&typeof options.toOutbox!=='boolean'))throw new OutboxPublicationError();
    const event=captureUnsignedEventTemplate(value.event,user);assertOutboxEventFrameFits(event,user);
    if(event.kind===22242 || event.kind===24242)throw new OutboxPublicationError('policy denied');
    return Object.freeze({type:'outbox.publish',id:text(value.id,128),event,
      options:Object.freeze({toOutbox:options.toOutbox!==false,
        toInboxes:Object.hasOwn(options,'toInboxes') ? outboxList(options.toInboxes,OUTBOX_LIST_LIMITS.authors,publicKey) : Object.freeze([]),
        relays:Object.hasOwn(options,'relays') ? outboxList(options.relays,OUTBOX_LIST_LIMITS.relays,normalizeRelayUrl) : Object.freeze([])})});
  } catch(error) {if(error instanceof OutboxPublicationError)throw error;throw new OutboxPublicationError();}
}
export function outboxPublishFailure(input:unknown,error:string):Readonly<{type:'outbox.publish.result';id:string;ok:false;error:string}>|null {
  try {const value=outboxRecord(input);if(value.type!=='outbox.publish')return null;return Object.freeze({type:'outbox.publish.result',id:text(value.id,128),ok:false,error});}
  catch {return null;}
}
