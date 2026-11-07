import {routingRecord,routingText,type JsonValue} from '../routing/routing-contract.ts';
import {normalizeRelayUrl} from '../network/relay-settings.ts';
import {captureCvmJson} from './cvm-json.ts';
import {publicKey} from '../storage/codec.ts';

/** Selected free encrypted profile; these are host limits, not protocol constants. */
export const CVM_LIMITS=Object.freeze({messageBytes:32*1024,requestMs:120_000,defaultMs:30_000,
  endpoints:2,requestsPerEndpoint:1,streamBytes:2*1024*1024,reorderFrames:16,nonceBytes:64,relays:4});
export const CVM_OPERATIONS=Object.freeze(['cvm.request','cvm.close','cvm.discover','cvm.registry.list','cvm.registry.has','cvm.registry.describe','cvm.registry.call']);
export type CvmFailure='invalid message'|'invalid request'|'invalid timeout'|'timeout out of policy'|
  'unsupported method'|'unsupported kind'|'server not found'|'relay timeout'|'initialization failed'|
  'session closed'|'payment required'|'payment denied'|'policy denied'|'provider unavailable'|
  'family not found'|'schema mismatch'|'cache policy denied';
export class CvmError extends Error {readonly code:CvmFailure;constructor(code:CvmFailure){super(code);this.code=code;this.name='CvmError';}}
export type CvmObject=Readonly<{[key:string]:JsonValue}>;
export type McpId=string|number;
export type McpMessage=Readonly<{jsonrpc:'2.0';id?:McpId;method?:string;params?:CvmObject;result?:CvmObject;error?:CvmObject}>;
export type CvmServer=Readonly<{pubkey:string;relays?:readonly string[]}>;
export type CvmOptions=Readonly<{timeoutMs:number;initialize:boolean;payment:'deny'|'prompt'|'allow'}>;
export type CvmRequest=Readonly<{type:'cvm.request';id:string;server:CvmServer;message:McpMessage;options:CvmOptions}>;
export type CvmClose=Readonly<{type:'cvm.close';id:string;server:CvmServer}>;
export type CvmUnsupported=Readonly<{type:'cvm.discover'|'cvm.registry.list'|'cvm.registry.has'|'cvm.registry.describe'|'cvm.registry.call';id:string}>;
export type CvmOperation=CvmRequest|CvmClose|CvmUnsupported;
const invalid=(code:CvmFailure):never=>{throw new CvmError(code);};
export function cvmRecord(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  try{return routingRecord(value,required,optional);}catch{return invalid('invalid request');}
}
export function cvmText(value:unknown,maximum=128):string{
  try{return routingText(value,maximum);}catch{return invalid('invalid request');}
}
export function cvmObject(value:unknown):CvmObject{
  try{
    const captured=captureCvmJson(value);
    if(!captured||typeof captured!=='object'||Array.isArray(captured))return invalid('invalid request');
    return captured as CvmObject;
  }catch{return invalid('invalid request');}
}
export function mcpId(value:unknown):McpId{
  if(typeof value==='number'&&Number.isSafeInteger(value))return value;
  if(typeof value==='string'&&value.length<=128)return value;
  return invalid('invalid message');
}
export const mcpKey=(id:McpId):string=>typeof id+':'+id;
export function captureMcp(value:unknown):McpMessage{
  try{
    const row=routingRecord(value,['jsonrpc'],['id','method','params','result','error']);
    if(row.jsonrpc!=='2.0')return invalid('invalid message');
    const has=(key:string)=>Object.prototype.hasOwnProperty.call(row,key);
    const request=has('method'),response=has('result')!==has('error');
    if(request&&(has('result')||has('error'))||!request&&(!has('id')||has('params')||!response))return invalid('invalid message');
    const id=has('id')?mcpId(row.id):undefined;if(has('id'))row.id=id;
    if(request)cvmText(row.method);
    for(const field of ['params','result','error'])if(has(field))row[field]=cvmObject(row[field]);
    if(has('error')){
      const error=routingRecord(row.error,['code','message'],['data']);
      if(!Number.isSafeInteger(error.code)||typeof error.message!=='string')return invalid('invalid message');
    }
    const captured=cvmObject(row);
    if(new TextEncoder().encode(JSON.stringify(captured)).length>CVM_LIMITS.messageBytes)return invalid('invalid message');
    return Object.freeze({...captured,...(id===undefined?{}:{id})}) as McpMessage;
  }catch{return invalid('invalid message');}
}
/** Private carrier metadata is derived from, and later checked against, the exact captured MCP. */
export function cvmMetadata(message:McpMessage):Readonly<{operation:string;progressTokenJSON:string|null}>{
  const meta=message.params?._meta;
  const token=meta&&typeof meta==='object'&&!Array.isArray(meta)?(meta as CvmObject).progressToken:undefined;
  const progressTokenJSON=token===undefined?null:JSON.stringify(mcpId(token));
  return Object.freeze({operation:message.method??'Send response',progressTokenJSON});
}
/** Cancellation is a notification about a typed client request ID, never an arbitrary provider command. */
export function cvmCancellationKey(message:McpMessage):string|null{
  if(message.method!=='notifications/cancelled')return null;
  if(message.id!==undefined||!message.params||!Object.prototype.hasOwnProperty.call(message.params,'requestId')||
    message.params.reason!==undefined&&typeof message.params.reason!=='string')throw new CvmError('invalid message');
  return mcpKey(mcpId(message.params.requestId));
}
export function captureServer(value:unknown):CvmServer{
  try{
    const row=routingRecord(value,['pubkey'],['relays']);const pubkey=publicKey(row.pubkey);
    if(row.relays===undefined)return Object.freeze({pubkey});
    if(!Array.isArray(row.relays)||row.relays.length>CVM_LIMITS.relays)return invalid('invalid request');
    const relays=row.relays.map(normalizeRelayUrl);
    if(new Set(relays).size!==relays.length)return invalid('invalid request');
    return Object.freeze({pubkey,relays:Object.freeze(relays)});
  }catch{return invalid('invalid request');}
}
export function captureOptions(value:unknown):CvmOptions{
  const row=value===undefined?{}:cvmRecord(value,[],['timeoutMs','initialize','payment']);
  const has=(key:string)=>Object.prototype.hasOwnProperty.call(row,key);
  const timeout=has('timeoutMs')?row.timeoutMs:CVM_LIMITS.defaultMs;
  if(!Number.isSafeInteger(timeout)||(timeout as number)<1||(timeout as number)>300_000)return invalid('invalid timeout');
  if((timeout as number)>CVM_LIMITS.requestMs)return invalid('timeout out of policy');
  if(row.initialize!==undefined&&typeof row.initialize!=='boolean')return invalid('invalid request');
  const payment=has('payment')?row.payment:'prompt';
  if(!['deny','prompt','allow'].includes(payment as string))return invalid('invalid request');
  return Object.freeze({timeoutMs:timeout as number,initialize:row.initialize??true,payment}) as CvmOptions;
}
function selector(value:unknown):void{
  const row=cvmRecord(value,[],['family','schemaHash']);
  if(row.family===undefined&&row.schemaHash===undefined)return invalid('invalid request');
  if(row.family!==undefined)cvmText(row.family);
  if(row.schemaHash!==undefined){try{publicKey(row.schemaHash);}catch{return invalid('invalid request');}}
}
function query(value:unknown,registry:boolean):void{
  if(value===undefined)return;
  const row=cvmRecord(value,[],registry?['search','family','schemaHash','category','limit']:['search','kinds','relays','limit']);
  for(const name of ['search','family','category'])if(row[name]!==undefined)cvmText(row[name],1024);
  if(row.limit!==undefined&&(!Number.isSafeInteger(row.limit)||(row.limit as number)<1))return invalid('invalid request');
  if(row.schemaHash!==undefined)selector({schemaHash:row.schemaHash});
  if(row.kinds!==undefined&&(!Array.isArray(row.kinds)||row.kinds.length>16||row.kinds.some(k=>!Number.isSafeInteger(k)||k<0)))return invalid('invalid request');
  if(row.relays!==undefined)captureServer({pubkey:'1'.repeat(64),relays:row.relays});
}
export function parseCvmOperation(value:unknown):CvmOperation{
  const peek=cvmRecord(value,['type','id'],['server','message','options','query','selector','tool','args']);
  const id=cvmText(peek.id);
  if(peek.type==='cvm.request'){
    const row=cvmRecord(value,['type','id','server','message'],['options']);
    return Object.freeze({type:'cvm.request',id,server:captureServer(row.server),message:captureMcp(row.message),options:captureOptions(row.options)});
  }
  if(peek.type==='cvm.close'){
    const row=cvmRecord(value,['type','id','server']);return Object.freeze({type:'cvm.close',id,server:captureServer(row.server)});
  }
  if(peek.type==='cvm.discover'||peek.type==='cvm.registry.list'){
    const row=cvmRecord(value,['type','id'],['query']);query(row.query,peek.type==='cvm.registry.list');
  }else if(peek.type==='cvm.registry.has'||peek.type==='cvm.registry.describe'||peek.type==='cvm.registry.call'){
    const call=peek.type==='cvm.registry.call';
    const row=cvmRecord(value,call?['type','id','selector','tool']:['type','id','selector'],call?['args','options']:['options']);
    selector(row.selector);if(call){cvmText(row.tool);if(row.args!==undefined)cvmObject(row.args);}
    if(row.options!==undefined){
      const options=cvmRecord(row.options,[],call?['server','timeoutMs','initialize','payment','cache']:['server']);
      if(options.server!==undefined)captureServer(options.server);
      if(call){captureOptions(Object.fromEntries(Object.entries(options).filter(([key])=>key!=='server'&&key!=='cache')));
        if(options.cache!==undefined&&!['default','reload','no-store'].includes(options.cache as string))return invalid('invalid request');}
    }
  }else return invalid('unsupported method');
  return Object.freeze({...cvmObject(value),type:peek.type as CvmUnsupported['type'],id});
}
export function cvmFailure(type:string,id:string,error:unknown):Readonly<Record<string,unknown>>{
  return Object.freeze({type:type+'.result',id,error:error instanceof CvmError?error.code:'policy denied'});
}
