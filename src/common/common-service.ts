import type {IdentityDataPort} from '../identity/identity-service.ts';
import {profileFilters,profileFromEvents,latestIdentityEvent,verifiedIdentityEvents} from '../identity/identity-contract.ts';
import type {RelayQueryService} from '../network/native-relay-query.ts';
import type {OutboxReadService} from '../outbox/read-service.ts';
import type {NativeRegistration} from '../runtime/capability-protocol.ts';
import {publicKey} from '../storage/codec.ts';
import {commonProfilePubkey,decodeCommonNip19,encodeCommonNip19} from './common-codec.ts';
import {CommonError,commonFailure,type CommonReply,type CommonRequest} from './common-contract.ts';

export async function readCommon(request:CommonRequest,registration:NativeRegistration,signal:AbortSignal,active:()=>void,
  services:Readonly<{queries?:RelayQueryService;identity?:IdentityDataPort;outbox?:OutboxReadService;token:string}>):Promise<CommonReply> {
  active();
  if (!registration.domains.includes('common')) throw new CommonError();
  const base = {type:`${request.type}.result`,id:request.id};
  if (request.type === 'common.encodeNip19') return Object.freeze({...base,...encodeCommonNip19(request.input)});
  if (request.type === 'common.decodeNip19') return Object.freeze({...base,...decodeCommonNip19(request.value)});
  if (request.type === 'common.follows') {
    if (!registration.domains.includes('identity') || !services.identity) return commonFailure(request)!;
    const result = await services.identity.read({type:'identity.getFollows',id:request.id},registration,signal,active);
    active();
    if (result.error !== undefined || !Array.isArray(result.pubkeys)) return commonFailure(request,'relay-timeout')!;
    const pubkeys = Object.freeze(result.pubkeys.map(publicKey));
    return Object.freeze({...base,ok:true,pubkeys});
  }
  if (request.type !== 'common.getProfile') return commonFailure(request)!;
  let pubkey:string;
  try {pubkey = commonProfilePubkey(request.target);}
  catch {return commonFailure(request,'invalid-profile-target')!;}
  try {
    const filters = profileFilters(pubkey);
    let rows;
    if (registration.domains.includes('relay') && services.queries?.queryDetailed) {
      const result = await services.queries.queryDetailed(filters,signal,active);
      if (result.incomplete && !result.events.length) throw new CommonError('relay-timeout');
      rows = result.events;
    } else if (registration.domains.includes('outbox') && services.outbox) {
      const result = await services.outbox.query({type:'outbox.query',id:request.id,filters,
        options:{authors:[pubkey],limit:4}},registration.user,signal,active,services.token);
      if (result.incomplete && !result.events.length) throw new CommonError('relay-timeout');
      rows = result.events;
    } else return Object.freeze({...base,ok:false,pubkey,error:'unsupported'});
    active();
    const events = verifiedIdentityEvents(rows.map(row=>row.event),filters);
    const event = latestIdentityEvent(events);
    return Object.freeze({...base,ok:true,pubkey,profile:profileFromEvents(events),
      ...(event ? {result:Object.freeze({event})} : {})});
  } catch (error) {
    active();
    return Object.freeze({...base,ok:false,pubkey,error:error instanceof CommonError ? error.message : 'relay-timeout'});
  }
}
