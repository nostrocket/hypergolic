import {createAppDataPlanner} from './app-data-plan.ts';
import {createNativeRelayQuery} from '../network/native-relay-query.ts';
import type {QueryBatchVerifier} from '../network/native-event-verifier.ts';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay.ts';
import type {RelaySettingsSnapshot} from '../network/relay-settings.ts';
import type {OutboxPublicationPlanner} from '../outbox/approval-preparation.ts';
/** App-owned public validation reads; the caller retains the actual Outbox or Relay approval origin. */
export function createNativeAppDataPlanner(native:NativePublishedRelayPort,settings:()=>RelaySettingsSnapshot,
  publication:OutboxPublicationPlanner,verifyBatch:QueryBatchVerifier){
  return createAppDataPlanner({settings,
    async query(filters,relays,signal,active){
      active();return createNativeRelayQuery(native,()=>relays,15_000,{outbox:true,verifyBatch}).queryDetailed(filters,signal,active);
    },
    publication:(request,user,signal,active)=>publication.plan(request,user,signal,active),
  });
}
