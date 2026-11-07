import {bech32} from '@scure/base';
import {decode, encodeBytes, neventEncode, naddrEncode, noteEncode, nprofileEncode, npubEncode} from 'nostr-tools/nip19';
import {publicKey,text} from '../storage/codec.ts';
import {CommonError,commonFields} from './common-contract.ts';

const publicTypes = new Set(['npub','note','nprofile','nevent','naddr','nrelay']);
function kind(value:unknown):number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65535) throw new CommonError('invalid-nip19');
  return value;
}
function relay(value:unknown):string {
  const result = text(value,255), url = new URL(result);
  if (!['wss:','ws:'].includes(url.protocol) || url.username || url.password || url.hash ||
      /[^\u0021-\u007e]/.test(result)) throw new CommonError('invalid-nip19');
  return result;
}
function relayHints(value:unknown):string[]|undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16 ||
      Reflect.ownKeys(value).length !== value.length + 1) throw new CommonError('invalid-nip19');
  const result:string[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value,index);
    if (!property || !Object.hasOwn(property,'value')) throw new CommonError('invalid-nip19');
    result.push(relay(property.value));
  }
  return result;
}
export function encodeCommonNip19(input:Record<string,unknown>) {
  try {
    if (!publicTypes.has(input.type as string)) throw new CommonError('unsupported-nip19-type');
    let value:string;
    switch (input.type) {
      case 'npub': case 'note':
        commonFields(input,['type','hex']);
        value = input.type === 'npub' ? npubEncode(publicKey(input.hex)) : noteEncode(publicKey(input.hex));
        break;
      case 'nprofile':
        commonFields(input,['type','pubkey'],['relays']);
        value = nprofileEncode({pubkey:publicKey(input.pubkey),relays:relayHints(input.relays)});
        break;
      case 'nevent':
        commonFields(input,['type','eventId'],['author','kind','relays']);
        value = neventEncode({id:publicKey(input.eventId),relays:relayHints(input.relays),
          ...(input.author === undefined ? {} : {author:publicKey(input.author)}),
          ...(input.kind === undefined ? {} : {kind:kind(input.kind)})});
        break;
      case 'naddr':
        commonFields(input,['type','identifier','pubkey','kind'],['relays']);
        value = naddrEncode({identifier:text(input.identifier,255,true),pubkey:publicKey(input.pubkey),
          kind:kind(input.kind),relays:relayHints(input.relays)});
        break;
      default: {
        commonFields(input,['type','relay']);
        const bytes = new TextEncoder().encode(relay(input.relay));
        value = encodeBytes('nrelay',Uint8Array.from([0,bytes.length,...bytes]));
      }
    }
    text(value,5000);
    return Object.freeze({ok:true,value,nip19Type:input.type as string});
  } catch (error) {
    return Object.freeze({ok:false,error:error instanceof CommonError && error.message === 'unsupported-nip19-type'
      ? error.message : 'invalid-nip19'});
  }
}
function decodeRelay(value:string) {
  const decoded = bech32.decode(value as `${string}1${string}`,5000);
  if (decoded.prefix !== 'nrelay') throw new CommonError('invalid-nip19');
  const bytes = bech32.fromWords(decoded.words);
  let selected:string|undefined;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 2 > bytes.length) throw new CommonError('invalid-nip19');
    const type = bytes[offset++]!, length = bytes[offset++]!;
    if (offset + length > bytes.length) throw new CommonError('invalid-nip19');
    if (type === 0) {
      if (selected !== undefined) throw new CommonError('invalid-nip19');
      selected = relay(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset,offset+length)));
    }
    offset += length;
  }
  if (selected === undefined) throw new CommonError('invalid-nip19');
  return {ok:true,nip19Type:'nrelay',relay:selected};
}
function verifyPointerText(value:string):void {
  const {prefix,words} = bech32.decode(value as `${string}1${string}`,5000);
  if (!['nprofile','nevent','naddr'].includes(prefix)) return;
  const bytes = bech32.fromWords(words), decoder = new TextDecoder('utf-8',{fatal:true});
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 2 > bytes.length) throw new CommonError('invalid-nip19');
    const type = bytes[offset++]!,length = bytes[offset++]!;
    if (offset + length > bytes.length) throw new CommonError('invalid-nip19');
    if (type === 1) relay(decoder.decode(bytes.subarray(offset,offset+length)));
    else if (prefix === 'naddr' && type === 0) text(decoder.decode(bytes.subarray(offset,offset+length)),255,true);
    offset += length;
  }
}
export function decodeCommonNip19(input:string):Readonly<Record<string,unknown> & {ok:boolean}> {
  try {
    const value = text(input,5000);
    if (/^nsec1/i.test(value)) throw new CommonError('unsupported-nip19-type');
    if (/^nrelay1/i.test(value)) return Object.freeze(decodeRelay(value));
    verifyPointerText(value);
    const decoded = decode(value);
    switch (decoded.type) {
      case 'npub': return Object.freeze({ok:true,nip19Type:decoded.type,hex:publicKey(decoded.data),pubkey:decoded.data});
      case 'note': return Object.freeze({ok:true,nip19Type:decoded.type,hex:publicKey(decoded.data),eventId:decoded.data});
      case 'nprofile': return Object.freeze({ok:true,nip19Type:decoded.type,pubkey:publicKey(decoded.data.pubkey),relays:relayHints(decoded.data.relays) ?? []});
      case 'nevent': return Object.freeze({ok:true,nip19Type:decoded.type,eventId:publicKey(decoded.data.id),relays:relayHints(decoded.data.relays) ?? [],
        ...(decoded.data.author === undefined ? {} : {author:publicKey(decoded.data.author)}),
        ...(decoded.data.kind === undefined ? {} : {kind:kind(decoded.data.kind)})});
      case 'naddr': return Object.freeze({ok:true,nip19Type:decoded.type,pubkey:publicKey(decoded.data.pubkey),
        identifier:text(decoded.data.identifier,255,true),kind:kind(decoded.data.kind),relays:relayHints(decoded.data.relays) ?? []});
      default: throw new CommonError('unsupported-nip19-type');
    }
  } catch (error) {
    return Object.freeze({ok:false,error:error instanceof CommonError && error.message === 'unsupported-nip19-type'
      ? error.message : 'invalid-nip19'});
  }
}
export function commonProfilePubkey(target:string):string {
  if (/^[0-9a-f]{64}$/.test(target)) return target;
  const decoded = decodeCommonNip19(target);
  if (!decoded.ok || !['npub','nprofile'].includes(decoded.nip19Type as string)) throw new CommonError('invalid-profile-target');
  return publicKey(decoded.pubkey);
}
