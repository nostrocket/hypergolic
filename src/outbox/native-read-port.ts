import {createOutboxPublicationPlanner} from './publication-plan';
import {requireNativeModule} from 'expo';
import type {NativePublishedRelayPort} from '../napplets/native-published-relay';
import {createNativeRelayQuery} from '../network/native-relay-query';
import type {RelaySettingsSnapshot} from '../network/relay-settings';
import {createOutboxAuthorResolver} from './author-resolver';
import {createOutboxReadService} from './read-service';
import type {OutboxRelayListCache} from './relay-list-cache';

/** Native module and trusted Lookup/Network settings never enter guest configuration. */
export function loadNativeOutboxReadService(cache: OutboxRelayListCache, settings: () => RelaySettingsSnapshot) {
  const native = requireNativeModule<NativePublishedRelayPort>('HypergolicNappletHost');
  const discovery = createNativeRelayQuery(native, () => settings().lookupRelays);
  const resolver=createOutboxAuthorResolver(cache,discovery);
  return Object.freeze({...createOutboxReadService(resolver,native,settings),publication:createOutboxPublicationPlanner(resolver,settings,{ancillaryWhenOutboxSkipped:'omit'})});
}
