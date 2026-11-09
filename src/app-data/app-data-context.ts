import {APP_DATA_PROFILE,APP_DATA_MAX_CONTENT_BYTES,deriveAppDataScope} from './app-data-contract.ts';
import {normalizeRelayUrl,MAX_RELAYS_PER_ROLE} from '../network/relay-settings.ts';

export type AppDataPolicy=Readonly<{profile:typeof APP_DATA_PROFILE;scope:string;maxContentBytes:typeof APP_DATA_MAX_CONTENT_BYTES;
  relays:readonly string[];defaultRelays:readonly string[]}>;
/** Private trusted configuration; only policy is exposed through NAP-SHELL. */
export type AppDataContext=Readonly<{sourceKind:35129;policy:AppDataPolicy}>;
type Source=Readonly<{publisher:string;appId:string;fixture:string;domains:readonly string[]}>;
function invalid():never{throw new Error('Invalid application-data context');}
function record(value:unknown,fields:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)invalid();
  const own=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==fields.length||fields.some(key=>!own[key]||!Object.prototype.hasOwnProperty.call(own[key],'value')))invalid();
  return Object.fromEntries(fields.map(key=>[key,own[key]!.value]));
}
export function selectedAppDataRelays(network:readonly string[]):readonly string[]{
  if(!Array.isArray(network)||Object.getPrototypeOf(network)!==Array.prototype||Reflect.ownKeys(network).length!==network.length+1)invalid();
  const descriptors=Object.getOwnPropertyDescriptors(network);
  const normalized=Array.from({length:network.length},(_,index)=>{
    const field=descriptors[String(index)];if(!field||!Object.prototype.hasOwnProperty.call(field,'value')||typeof field.value!=='string')invalid();
    return normalizeRelayUrl(field.value);
  });
  if(normalized.length>MAX_RELAYS_PER_ROLE||new Set(normalized).size!==normalized.length)invalid();
  return Object.freeze(normalized.slice(0,8));
}
/** Clone native-held context, independently matching its verified-source namespace. */
export function captureAppDataContext(input:unknown,source:Source):AppDataContext{
  if(source.fixture!=='published'||!source.domains.includes('identity')||!source.domains.some(domain=>domain==='outbox'||domain==='relay'))invalid();
  const value=record(input,['sourceKind','policy']);if(value.sourceKind!==35129)invalid();
  const policy=record(value.policy,['profile','scope','maxContentBytes','relays','defaultRelays']);
  const expected=deriveAppDataScope({publisher:source.publisher,kind:35129,identifier:source.appId});
  if(policy.profile!==APP_DATA_PROFILE||policy.scope!==expected||policy.maxContentBytes!==APP_DATA_MAX_CONTENT_BYTES||
    !Array.isArray(policy.relays)||policy.relays.length<1||policy.relays.length>8||
    !Array.isArray(policy.defaultRelays)||policy.defaultRelays.length!==1)invalid();
  const rawRelays=policy.relays as unknown[];
  const relays=selectedAppDataRelays(policy.relays),defaults=selectedAppDataRelays(policy.defaultRelays);
  if(relays.some((url,index)=>url!==rawRelays[index]||new TextEncoder().encode(url).byteLength>256)||defaults[0]!==relays[0]||defaults[0]!==policy.defaultRelays[0])invalid();
  return Object.freeze({sourceKind:35129,policy:Object.freeze({profile:APP_DATA_PROFILE,scope:expected,maxContentBytes:APP_DATA_MAX_CONTENT_BYTES,
    relays,defaultRelays:Object.freeze([relays[0]!] )})});
}
export function assertCurrentAppDataSettings(context:AppDataContext,network:readonly string[]):void{
  if(JSON.stringify(context.policy.relays)!==JSON.stringify(selectedAppDataRelays(network)))throw new Error('app-data-settings-changed');
}
