import {createNativeAppDataPlanner} from '../app-data/native-app-data-plan';
import {createNativeCommonSocialPlanner} from '../common/native-social-plan';
import {createOutboxPublicationPlanner} from './publication-plan';
import {requireNativeModule} from 'expo';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay';
import {createNativeRelayQuery} from '../network/native-relay-query';
import {createNativeEventVerifier, type PublicVerificationModule} from '../network/native-event-verifier';
import type {RelaySettingsSnapshot} from '../network/relay-settings';
import {createOutboxAuthorResolver} from './author-resolver';
import {createOutboxReadService, type NativeOutboxQueryPort} from './read-service';
import type {OutboxRelayListCache} from './relay-list-cache';

/** Native module and trusted Lookup/Network settings never enter guest configuration. */
export function loadNativeOutboxReadService(cache: OutboxRelayListCache, settings: () => RelaySettingsSnapshot,signer:(user:string,active:()=>void)=>Promise<boolean> = async()=>false) {
  const native = requireNativeModule<NativePublishedRelayPort & NativeOutboxQueryPort>('HypergolicNappletHost');
  const verifier = createNativeEventVerifier(requireNativeModule<PublicVerificationModule>('HypergolicSignerCore'),()=>native.newInstanceId());
  const discovery = createNativeRelayQuery(native, () => settings().lookupRelays);
  const resolver=createOutboxAuthorResolver(cache,discovery);
  const publication=createOutboxPublicationPlanner(resolver,settings,{ancillaryWhenOutboxSkipped:'omit'});
  return Object.freeze({...createOutboxReadService(resolver,native,settings,Date.now,verifier),publication,appData:createNativeAppDataPlanner(native,settings,publication,verifier),common:createNativeCommonSocialPlanner(native,resolver,settings,publication,signer)});
}
