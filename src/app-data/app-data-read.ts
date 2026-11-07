import {APP_DATA_PROFILE} from './app-data-contract.ts';
import {assertCurrentAppDataSettings,type AppDataContext} from './app-data-context.ts';
import type {OutboxQueryRequest} from '../outbox/query-contract.ts';
import {OutboxQueryError} from '../outbox/query-contract.ts';
import type {OutboxReadPlan} from '../outbox/route-plan.ts';
/** Only the convention's structured list/exact-address queries select storage-only routing. */
export function isAppDataRead(request:OutboxQueryRequest):boolean{
  const strings=(value:unknown):readonly string[]|null=>Array.isArray(value)&&value.every(item=>typeof item==='string')?value:null;
  return request.filters.every(filter=>{
    const kinds=filter.kinds;
    if(filter.search!==undefined||!Array.isArray(kinds)||kinds.length!==1||kinds[0]!==30078)return false;
    const addresses=strings(filter['#d']);
    if(addresses?.length)return addresses.every(value=>/^soy\.app-data\/1:[a-f0-9]{64}:[a-z][a-z0-9_-]{0,47}:[a-zA-Z0-9_-]{1,64}$/.test(value));
    const labels=strings(filter['#L']),scopes=strings(filter['#s']),collections=strings(filter['#c']);
    return labels?.length===1&&labels[0]===APP_DATA_PROFILE&&!!scopes?.length&&scopes.every(value=>/^[a-f0-9]{64}$/.test(value))&&
      !!collections?.length&&collections.every(value=>/^[a-z][a-z0-9_-]{0,47}$/.test(value));
  });
}
export function appDataReadPlan(request:OutboxQueryRequest,context:AppDataContext|undefined,network:readonly string[]):OutboxReadPlan|null{
  if(!context||!request.options.relays.length||!isAppDataRead(request))return null;
  try{assertCurrentAppDataSettings(context,network);}catch{throw new OutboxQueryError('policy denied');}
  if(request.options.relays.length>8||request.options.relays.some(peer=>!context.policy.relays.includes(peer)))throw new OutboxQueryError('policy denied');
  return Object.freeze({relays:Object.freeze([...request.options.relays]),source:'fallback',missingAuthors:Object.freeze([]),incomplete:false});
}
