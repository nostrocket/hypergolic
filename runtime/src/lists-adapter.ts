import type {NappletMessage, ServiceHandler} from '@kehto/runtime';
import {verifyEvent} from 'nostr-tools/pure';
import {APP_CURATION_LIST, isRecord, LIST_PREPARE, LIST_PUBLICATION_PREFIX, listHeader, recommendationAddition} from '../../src/lists/napplet-recommendations';
import type {createNativeClient} from './native-client';
import {normalizeRelayUrl} from '../../src/network/relay-settings';

function preparedEvent(value: Record<string, unknown>, coordinate: string) {
  const event = value.event;
  if (value.status !== 'prepared' || Object.keys(value).length !== 3 || !isRecord(event) ||
      Object.keys(event).length !== 4 || event.kind !== 30267 ||
      !Number.isSafeInteger(event.created_at) || Number(event.created_at) < 0 || typeof event.content !== 'string' ||
      !Array.isArray(event.tags) || event.tags.length > 512 ||
      !event.tags.every(tag => Array.isArray(tag) && tag.length <= 256 && tag.every(field => typeof field === 'string'))) {
    throw Error('Invalid list preparation');
  }
  const serialized = JSON.stringify(event);
  if (serialized.length > 65_536 || new TextEncoder().encode(serialized).length > 65_536) throw Error('List is too large');
  const tags = event.tags as string[][];
  if (tags.filter(tag => tag[0] === 'd').length !== 1 || !tags.some(tag => tag.length === 2 && tag[0] === 'd' && tag[1] === 'napplets') ||
      !tags.some(tag => tag[0] === 'a' && tag[1] === coordinate)) throw Error('Invalid list target');
  const relays = value.relays;
  if (!Array.isArray(relays) || !relays.length || relays.length > 16 ||
      !relays.every(relay => typeof relay === 'string' && relay.length <= 512) ||
      new Set(relays.map(normalizeRelayUrl)).size !== relays.length) throw Error('Invalid list destinations');
  return JSON.parse(serialized) as typeof event;
}

export function createListsAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean): ServiceHandler {
  let pending = false;
  return {descriptor: {name:'lists',version:'1.0.0'}, handleMessage(_window, message, send) {
    const header = listHeader(message);
    if (!header || !isRecord(message)) return;
    const live = captureRecipient();
    const reply = (fields: object) => {
      if (live()) send({type:header.type + '.result', id:header.id, ...fields} as NappletMessage);
    };
    if (message.type === 'lists.supported') { reply({lists:[APP_CURATION_LIST]}); return; }
    const request = recommendationAddition(message);
    if ('error' in request) {
      reply({ok:false, error:request.error, ...(request.error === 'unsupported-list' ? {supported:[APP_CURATION_LIST],reason:'Only the napplets app curation set is available.'} : {})});
      return;
    }
    if (pending) { reply({ok:false,error:'list-unavailable'}); return; }
    pending = true;
    let publishing = false;
    void (async () => {
      const {coordinate, create} = request;
      const work = await native.request({type:LIST_PREPARE,id:crypto.randomUUID(),coordinate,create} as NappletMessage,undefined,26_000);
      if (!live()) return;
      const result = isRecord(work) ? work.result : undefined;
      if (!isRecord(result)) throw Error('Missing list preparation');
      if (result.status === 'already-recommended') {reply({ok:true,added:0,skipped:1});return;}
      if (result.status !== 'prepared') {reply({ok:false,error: result.status === 'missing' ? 'list-not-found' : 'list-unavailable'});return;}
      const {account, ...planResult} = result;
      const event = preparedEvent(planResult, coordinate);
      publishing = true;
      const receipt = await native.request({type:'relay.publish',id:LIST_PUBLICATION_PREFIX + crypto.randomUUID(),event} as NappletMessage,undefined,660_000);
      if (!live()) return;
      if (!isRecord(receipt)) throw Error('Invalid publication receipt');
      if (receipt.ok === false && ['approval denied','user-denied','no relay accepted the event'].includes(String(receipt.error))) {
        reply({ok:false,error:receipt.error === 'no relay accepted the event' ? 'publish-failed' : 'user-denied'});return;
      }
      const signed = receipt.event;
      if (!isRecord(signed) || receipt.ok !== true || receipt.eventId !== signed.id || signed.pubkey !== account ||
          signed.kind !== event.kind || signed.created_at !== event.created_at || signed.content !== event.content ||
          JSON.stringify(signed.tags) !== JSON.stringify(event.tags) || !verifyEvent(signed as never)) throw Error('Unconfirmed list publication');
      reply({ok:true,eventId:signed.id,added:1,skipped:0});
    })().catch(() => reply({ok:false,error:publishing ? 'publication-result-unknown' : 'list-unavailable'}))
      .finally(() => { pending = false; });
  }};
}
