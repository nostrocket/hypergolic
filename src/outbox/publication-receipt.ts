import {validateSignedEvent,type VerifiedSignedEvent} from '../security/signed-event.ts';
import {captureRelayOutcomes} from '../security/relay-outcomes.ts';
import type {RelayOutcome} from '../network/relay-service.ts';
import type {OutboxPublicationPlan} from './publication-plan.ts';
export type OutboxPublicationReceipt=Readonly<{primary:Readonly<{event:VerifiedSignedEvent;outcomes:readonly RelayOutcome[];ok:boolean}>;
  ancillary:Readonly<{event:VerifiedSignedEvent;outcomes:readonly RelayOutcome[]}>|null;
  response:Readonly<{type:'outbox.publish.result';id:string;ok:boolean;relays:Readonly<Record<string,boolean>>;event?:VerifiedSignedEvent;eventId?:string;error?:string}>}>;
/** Missing ACKs are omitted from the boolean wire map and stay explicitly unknown in trusted receipts. */
export function captureOutboxPublicationReceipt(plan:OutboxPublicationPlan,signed:unknown,primaryInput:unknown,ancillaryInput:unknown):OutboxPublicationReceipt {
  const event=validateSignedEvent(plan.event,signed),outcomes=captureRelayOutcomes(primaryInput,plan.event.destinations,event.id);
  const accepted=new Set<string>(),relayEntries:[string,boolean][]=[];
  for(const row of outcomes){if(row.status==='accepted')accepted.add(row.relay);if(row.status!=='unknown')relayEntries.push([row.relay,row.status==='accepted']);}
  const ok=accepted.size>0&&plan.requiredInboxes.every(relay=>accepted.has(relay));
  const required=new Set(plan.requiredInboxes);
  const unknown=outcomes.some(row=>row.status==='unknown'&&(!required.size||required.has(row.relay)));
  const relays=Object.freeze(Object.fromEntries(relayEntries));
  const ancillary=plan.ancillary ? Object.freeze({event:plan.ancillary,outcomes:captureRelayOutcomes(ancillaryInput,plan.event.destinations,plan.ancillary.id)}) : null;
  if(!plan.ancillary&&ancillaryInput!==null)throw new Error('APPROVAL_DENIED');
  const error=unknown ? 'publication result unknown' : accepted.size ? 'required inbox relay did not accept the event' : 'no relay accepted the event';
  return Object.freeze({primary:Object.freeze({event,outcomes,ok}),ancillary,response:Object.freeze({type:'outbox.publish.result',id:plan.requestId,ok,relays,
    ...(ok ? {event,eventId:event.id} : {error})})});
}
