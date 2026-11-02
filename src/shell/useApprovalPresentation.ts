import {useState} from 'react';
import { VaultError } from '../security/identity-vault-model';
import { isSignerFailureCode, signerFailureMessage } from '../security/signing-methods';
import type {ApprovalItem,ApprovalService} from '../security/approval-service';
import type {OutboxPublicationReceipt} from '../outbox/publication-receipt';
import type {RelayOutcome} from '../network/relay-service';
type Presentation=Readonly<{service:ApprovalService;epoch:number;held:ApprovalItem|null;busy:boolean;receipt:OutboxPublicationReceipt|null;outcome:string|null}>;
function publicationStatus(results:readonly RelayOutcome[]):string {
 let accepted=0,unknown=0;
 for(const row of results){if(row.status==='accepted')accepted++;if(row.status==='unknown')unknown++;}
 if(accepted>0)return `Published to ${accepted} of ${results.length} relays.${unknown?' Other delivery could not be confirmed.':''}`;
 return unknown?'Publication could not be confirmed.':'No relay accepted the event.';
}
/** State belongs to its captured identity epoch and service. Old completions cannot replace a newer request. */
export function useApprovalPresentation(service:ApprovalService,epoch:number){
 const [stored,setStored]=useState<Presentation|null>(null);
 const state=stored?.epoch===epoch&&stored.service===service?stored:null;
 const approve=(item:ApprovalItem)=>{
  if(state?.busy)return;
  const pending:Presentation={service,epoch,held:item,busy:true,receipt:null,outcome:null};setStored(pending);
  void service.approve(item.id).then(results=>{
   const receipt=service.outboxReceipt(results),outcome=receipt?null:publicationStatus(results);
   setStored(current=>current===pending?{...pending,held:null,busy:false,receipt,outcome}:current);
  }).catch(error=>{
   const outcome=error instanceof VaultError&&isSignerFailureCode(error.code)?signerFailureMessage(error.code):'Approval was not completed.';
   setStored(current=>current===pending?{...pending,held:null,busy:false,outcome}:current);
  });
 };
 return {held:state?.held??null,busy:state?.busy??false,receipt:state?.receipt??null,outcome:state?.outcome??null,approve,
  dismissReceipt:()=>setStored(current=>current===state&&current?{...current,receipt:null}:current),
  dismissOutcome:()=>setStored(current=>current===state&&current?{...current,outcome:null}:current)};
}
