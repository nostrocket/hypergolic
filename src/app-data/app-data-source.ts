import {APP_DATA_PROFILE,APP_DATA_MAX_CONTENT_BYTES,deriveAppDataScope} from './app-data-contract.ts';
import {assertVerifiedArtifact,type VerifiedNappletArtifact} from '../napplets/verified-artifact.ts';
import {selectedAppDataRelays,type AppDataContext} from './app-data-context.ts';

/** Called only after source signature/body verification and reviewed grant admission. */
export function appDataContextForArtifact(input:VerifiedNappletArtifact,domains:readonly string[],network:readonly string[]):AppDataContext|null{
  assertVerifiedArtifact(input);
  if(input.manifest.kind!==35129)return null;
  if(!domains.includes('identity')||!domains.some(domain=>domain==='outbox'||domain==='relay'))return null;
  const relays=selectedAppDataRelays(network);if(!relays.length||relays.some(url=>new TextEncoder().encode(url).byteLength>256))return null;
  const identifier=input.manifest.tags.find(tag=>tag[0]==='d')?.[1];if(!identifier)throw new Error('Invalid application-data source');
  const policy=Object.freeze({profile:APP_DATA_PROFILE,scope:deriveAppDataScope({publisher:input.manifest.pubkey,kind:input.manifest.kind,identifier}),
    maxContentBytes:APP_DATA_MAX_CONTENT_BYTES,relays,defaultRelays:Object.freeze(relays.slice(0,1))});
  return Object.freeze({sourceKind:input.manifest.kind,policy});
}
