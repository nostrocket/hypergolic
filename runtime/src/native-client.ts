import {parseOutboxSubscribe,parseOutboxClose} from '../../src/outbox/subscription-contract';
import {normalizeRelayUrl} from '../../src/network/relay-settings';
import {captureConfigPush, captureConfigReply, type ConfigMessage} from '../../src/presentation/config-contract';
import { captureNotifyPush, captureNotifyReply, type NotifyMessage } from '../../src/presentation/notify-contract';
import { captureRoutingPush, captureRoutingReply } from './routing-adapter';
import type { RoutingMessage } from '../../src/routing/routing-contract';
import { captureUploadResult } from '../../src/uploads/upload-contract';
import { parseRelaySubscribe, parseRelayClose } from '../../src/network/relay-subscription-contract';
import { verifyQueryEvent } from '../../src/network/relay-query-contract';
import type { QueryFilter } from '../../src/network/relay-query-contract';
import type { NappletMessage } from '@kehto/runtime';

export interface NativeHost {
  postMessage(message: string): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
}
const maxBytes = 2 * 1024 * 1024;
const ordinaryTimeoutMs = 27_000;
type StreamState={domain:'relay'|'outbox';subId:string; filters:readonly QueryFilter[]; timer:number; delivery:number; eose:boolean; controlRevision:number; deliver:(message:NappletMessage)=>void};
type StreamEnvelope={sequence:number;delivery:number;response:unknown};
type NativeClientOptions = Readonly<{ requestTimeoutsMs?: Readonly<Record<string, number>>; onRouting?: (message: NappletMessage) => void }>;
function receiveStream(envelope:StreamEnvelope,streams:Map<number,StreamState>,stopStream:(counter:number,notify:boolean)=>void,acknowledge:(envelope:StreamEnvelope)=>void):void {
  const stream=streams.get(envelope.sequence);if(!stream)return;
  try {
    if(!Number.isSafeInteger(envelope.delivery)||envelope.delivery!==stream.delivery+1)throw new Error('Stream delivery mismatch');
    stream.delivery=envelope.delivery;
    if(typeof envelope.response!=='string'||new TextEncoder().encode(envelope.response).length>66*1024)throw new Error('Stream denied');
    const message=JSON.parse(envelope.response);
    if(!message||message.subId!==stream.subId)throw new Error('Stream mismatch');
    if(message.type===stream.domain+'.event') {
      const fields=new Set(['event',...(stream.domain==='outbox'?['sidecar']:[])]);
      if(Object.keys(message).length!==3||!message.result||Object.keys(message.result).some(key=>!fields.has(key))||!('event' in message.result))throw new Error('Invalid stream event');
      const event=verifyQueryEvent(message.result.event,stream.domain==='outbox'?stream.filters.map(filter=>({...filter,limit:32})):stream.filters);
      let sidecar:Readonly<{relayHints:readonly string[]}>|undefined;
      if(message.result.sidecar!==undefined){
        const value=message.result.sidecar;
        if(!value||Object.keys(value).length!==1||!Array.isArray(value.relayHints)||value.relayHints.length>16||new Set(value.relayHints).size!==value.relayHints.length)throw new Error('Invalid relay hints');
        sidecar=Object.freeze({relayHints:Object.freeze(value.relayHints.map(normalizeRelayUrl))});
      }
      if(event.kind===4||event.kind===1059)throw new Error('Unsupported encrypted stream');
      stream.deliver({type:stream.domain+'.event',subId:stream.subId,result:{event,...(sidecar?{sidecar}:{})}} as NappletMessage);
    }else if(message.type==='relay.eose'&&Object.keys(message).length===2) {
      window.clearTimeout(stream.timer);stream.eose=true;if(stream.domain==='relay')stream.deliver(message);
    }else if(message.type===stream.domain+'.closed'&&Object.keys(message).every(key=>['type','subId','reason'].includes(key))&&
      (message.reason===undefined||typeof message.reason==='string'&&message.reason.length<=256)) {
      streams.delete(envelope.sequence);window.clearTimeout(stream.timer);stream.eose=true;stream.deliver(message);
    }else throw new Error('Invalid stream lifecycle');
    acknowledge(envelope);
  }catch{stopStream(envelope.sequence,true);}
}
type ControlEnvelope={type:string;sessionId:string;sequence:number;active:boolean;revision:number};
function receiveControl(envelope:ControlEnvelope,generation:string,streams:Map<number,StreamState>,stopStream:(counter:number,notify:boolean)=>void):boolean {
      if(envelope?.type==='capability.stream-control'&&Object.keys(envelope).length===5&&envelope.sessionId===generation&&typeof envelope.active==='boolean'&&Number.isSafeInteger(envelope.revision)&&envelope.revision>=0) {
        const stream=streams.get(envelope.sequence);if(!stream||envelope.revision<=stream.controlRevision)return true;
        stream.controlRevision=envelope.revision;window.clearTimeout(stream.timer);
        if(envelope.active&&!stream.eose)stream.timer=window.setTimeout(()=>stopStream(envelope.sequence,true),ordinaryTimeoutMs);
        return true;
      }
  return false;
}
/** Internal native revocation: settle transport bookkeeping without a guest receipt. */
export class NativeRequestRevoked extends Error {}
type PendingRequest={type:string;id:string;timer:number;resolve:(message:NappletMessage)=>void;reject:(reason?: Error)=>void};
function receiveOrdinary(envelope:{sequence:number;response:unknown},pending:Map<number,PendingRequest>):void {
  const request = pending.get(envelope.sequence);
  if (!request) return;
  try {
    if ((request.type === 'link.open' || request.type === 'routing.call') && envelope.response === null) throw new NativeRequestRevoked('Native link owner revoked');
    if (typeof envelope.response !== 'string') throw new Error('Native request denied');
    const response = JSON.parse(envelope.response);
    if (!response || (response.type !== request.type + '.result' && !(request.type.startsWith('resource.') && response.type === request.type + '.error')) || response.id !== request.id) throw new Error('Native response mismatch');
    request.resolve(response);
  } catch (error) { request.reject(error instanceof NativeRequestRevoked ? error : undefined); }
  finally { pending.delete(envelope.sequence); window.clearTimeout(request.timer); }
}
type UploadState = {uploadId: string; delivery: number; bytesSent: number; onStatus(message: NappletMessage): void};
interface NativeReceiveState {generation: string; pending: Map<number, PendingRequest>; streams: Map<number, StreamState>; uploads: Map<number, UploadState>;
  stopStream(counter: number, notify: boolean): void; acknowledge(envelope: StreamEnvelope): void; routing(raw: unknown): boolean}
function receiveNative(raw: unknown, state: NativeReceiveState): void {
  const {generation, pending, streams, uploads, stopStream, acknowledge} = state;
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > maxBytes) return;
    try {
      const envelope = JSON.parse(raw);
      if(state.routing(envelope))return;
      if(receiveControl(envelope,generation,streams,stopStream))return;
      if (envelope?.type === 'capability.upload' && Object.keys(envelope).length === 5 && envelope.sessionId === generation) {
        const upload = uploads.get(envelope.sequence);
        if (!upload || !Number.isSafeInteger(envelope.delivery) || envelope.delivery !== upload.delivery + 1 ||
          typeof envelope.response !== 'string' || new TextEncoder().encode(envelope.response).length > 32 * 1024) return;
        const message = JSON.parse(envelope.response);
        if (!message || Object.keys(message).length !== 2 || message.type !== 'upload.status.changed') return;
        const status = captureUploadResult(message.status, upload.uploadId);
        if (status.bytesSent !== undefined && status.bytesSent < upload.bytesSent) return;
        upload.delivery = envelope.delivery; upload.bytesSent = status.bytesSent ?? upload.bytesSent;
        if (['complete', 'failed', 'cancelled'].includes(status.status)) uploads.delete(envelope.sequence);
        upload.onStatus({type: 'upload.status.changed', status} as NappletMessage); return;
      }
      if (!envelope || Object.keys(envelope).length !== (envelope.type==='capability.stream'?5:4) || !['capability.result','capability.stream'].includes(envelope.type) ||
          envelope.sessionId !== generation || !Number.isSafeInteger(envelope.sequence)) return;
      if(envelope.type==='capability.stream') {
        receiveStream(envelope,streams,stopStream,acknowledge);
        return;
      }
      receiveOrdinary(envelope,pending);
    } catch { /* An invalid native response has no destination or authority. */ }
}

function createRoutingReceiver(generation: string, deliver: NativeClientOptions['onRouting'], acknowledge: (delivery: number) => void): (value: unknown) => boolean {
  let routingDelivery = 0;
  const routing = (value: unknown): boolean => {
    const envelope = value as {type?: unknown; sessionId?: unknown; delivery?: unknown; response?: unknown};
    if (envelope?.type !== 'routing.event') return false;
    if (Object.keys(envelope).length !== 4 || envelope.sessionId !== generation || !Number.isSafeInteger(envelope.delivery) || (envelope.delivery as number) <= routingDelivery || typeof envelope.response !== 'string' || new TextEncoder().encode(envelope.response).length > 36 * 1024) return true;
    try {
      const raw = JSON.parse(envelope.response);
      const message = typeof raw?.type === 'string' && raw.type.startsWith('notify.') ? captureNotifyPush(raw) : typeof raw?.type === 'string' && raw.type.startsWith('config.') ? captureConfigPush(raw) : captureRoutingPush(raw);
      routingDelivery = envelope.delivery as number;
      deliver?.(message);
      acknowledge(routingDelivery);
    } catch { /* An invalid event never enters the SDK. */ }
    return true;
  };
  return routing;
}

type NativeUploadRequest = Readonly<{uploadId: string; onStatus(message: NappletMessage): void}>;
function enqueueRequest(native: NativeHost, pending: Map<number, PendingRequest>, uploads: Map<number, UploadState>,
  request: Readonly<{counter: number; encoded: string; id: string; type: string; timeoutMs: number; upload?: NativeUploadRequest}>): Promise<NappletMessage> {
  const {counter, encoded, id, type, timeoutMs, upload} = request;
      return new Promise((resolve, rejectPromise) => {
        const reject = (reason?: Error): void => { uploads.delete(counter); rejectPromise(reason ?? new Error('Native capability unavailable')); };
        if (upload) uploads.set(counter, {uploadId: upload.uploadId, delivery: 0, bytesSent: 0, onStatus: upload.onStatus});
        const timer = window.setTimeout(() => { pending.delete(counter); reject(); }, timeoutMs);
        pending.set(counter, { type, id, timer, resolve: response => {
          if (upload && !('result' in response)) uploads.delete(counter);
          resolve(response);
        }, reject });
        try { native.postMessage(encoded); }
        catch { pending.delete(counter); window.clearTimeout(timer); reject(); }
      });
}

function createPresentationRequests(request: (message: NappletMessage) => Promise<NappletMessage>) {
  return {
    async routing(message: RoutingMessage | Readonly<{type: 'routing.__register'}>): Promise<NappletMessage | null> {
      const id = 'routing-' + crypto.randomUUID();
      const wrapper = {type: 'routing.call', id, message}, response = await request(wrapper);
      if (!('response' in response)) throw new Error('Missing routing response');
      if (message.type === 'routing.__register') { if (response.response !== null) throw new Error('Invalid registration response'); return null; }
      return captureRoutingReply(response.response, message);
    },
    async notify(message: NotifyMessage | Readonly<{type: 'notify.__register'}>): Promise<NappletMessage | null> {
      const id = 'notify-' + crypto.randomUUID(), wrapper = {type: 'routing.call', id, message};
      const response = await request(wrapper);
      if (!('response' in response)) throw new Error('Missing notification response');
      if (message.type === 'notify.__register') {if (response.response !== null) throw new Error('Invalid registration response'); return null;}
      return captureNotifyReply(response.response, message);
    },
    async config(message: ConfigMessage): Promise<NappletMessage | null> {
      const id = 'config-' + crypto.randomUUID(), wrapper = {type: 'routing.call', id, message};
      const response = await request(wrapper);
      if (!('response' in response)) throw new Error('Missing configuration response');
      if (message.type === 'config.get' && response.response === null) return null;
      return captureConfigReply(response.response, message);
    },
  };
}

/** Trusted top document only. A response never selects its destination window. */
export function createNativeClient(native: NativeHost, generation: string, options: NativeClientOptions = {}) {
  let sequence = 0, disposed = false;
  const pending = new Map<number, PendingRequest>();
  const streams = new Map<number, StreamState>();
  const uploads = new Map<number, UploadState>();
  const callerIds = new Set<string>();
  const closeNative = (subId:string,domain:'relay'|'outbox',id?:string):void => {
    if(disposed || sequence >= Number.MAX_SAFE_INTEGER)return;
    const counter=++sequence;
    try { native.postMessage(JSON.stringify({type:'capability',sessionId:generation,sequence:counter,
      message:JSON.stringify({type:domain+'.close',id:id??'native-close-'+counter,subId})})); } catch { /* Native revocation also closes the stream. */ }
  };
  const stopStream = (counter:number,notify:boolean,id?:string):void => {
    const stream=streams.get(counter);if(!stream)return;
    streams.delete(counter);window.clearTimeout(stream.timer);closeNative(stream.subId,stream.domain,id);
    if(notify)stream.deliver({type:stream.domain+'.closed',subId:stream.subId,reason:'relay subscription unavailable'} as NappletMessage);
  };
  const acknowledge=(envelope:StreamEnvelope):void => {
    if(sequence>=Number.MAX_SAFE_INTEGER)throw new Error('Native sequence exhausted');
    native.postMessage(JSON.stringify({type:'relay-stream-ack',sessionId:generation,sequence:++sequence,streamSequence:envelope.sequence,delivery:envelope.delivery}));
  };
  function request(message: NappletMessage, upload?: Readonly<{uploadId: string; onStatus(message: NappletMessage): void}>): Promise<NappletMessage> {
      if (disposed || pending.size >= 4 || sequence >= Number.MAX_SAFE_INTEGER || !('id' in message) || typeof message.id !== 'string') {
        return Promise.reject(new Error('Native capability unavailable'));
      }
      if (upload && (message.type !== 'upload.__seal' || uploads.size >= 2 || typeof upload.uploadId !== 'string' ||
        upload.uploadId.length === 0 || upload.uploadId.length > 128)) return Promise.reject(new Error('Native upload unavailable'));
      const id = message.id;
      const counter = sequence + 1;
      const encoded = JSON.stringify({ type: 'capability', sessionId: generation, sequence: counter, message: JSON.stringify(message) });
      if (new TextEncoder().encode(encoded).length > maxBytes) return Promise.reject(new Error('Native request too large'));
      sequence = counter;
      return enqueueRequest(native, pending, uploads, {counter, encoded, id, type: message.type, timeoutMs: options.requestTimeoutsMs?.[message.type] ?? ordinaryTimeoutMs, ...(upload ? {upload} : {})});
   }
  const routing = createRoutingReceiver(generation, options.onRouting, delivery => {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Native sequence exhausted');
    native.postMessage(JSON.stringify({type: 'routing-ack', sessionId: generation, sequence: ++sequence, delivery}));
  });
  const receiving: NativeReceiveState = {generation, pending, streams, uploads, stopStream, acknowledge, routing};
  const receive = (raw: unknown): void => {if (!disposed) receiveNative(raw, receiving);};
  const android = (event: { data: unknown }): void => receive(event.data);
  const ios = (event: MessageEvent): void => {
    if (event.isTrusted && event.source === window && event.data?.type === 'hypergolic.native-response' &&
        Object.keys(event.data).length === 2) receive(event.data.message);
  };
  native.addEventListener?.('message', android);
  window.addEventListener('message', ios);
  return Object.freeze({
    subscribe(message:NappletMessage,deliver:(message:NappletMessage)=>void):void {
      const outbox=message.type==='outbox.subscribe',request=outbox?parseOutboxSubscribe(message):parseRelaySubscribe(message);
      if(disposed||streams.size>=2||callerIds.has(request.subId)||callerIds.size>=4096||sequence>=Number.MAX_SAFE_INTEGER)throw new Error('Native subscription unavailable');
      const counter=++sequence;
      callerIds.add(request.subId);
      const timer=window.setTimeout(()=>stopStream(counter,true),ordinaryTimeoutMs);
      streams.set(counter,{domain:outbox?'outbox':'relay',subId:request.subId,filters:request.filters,timer,delivery:0,eose:false,controlRevision:-1,deliver});
      try {native.postMessage(JSON.stringify({type:'relay-stream',sessionId:generation,sequence:counter,message:JSON.stringify(request)}));}
      catch{stopStream(counter,true);}
    },
    close(message:NappletMessage):void {
      const outbox=message.type==='outbox.close',request=outbox?parseOutboxClose(message):parseRelayClose(message);
      for(const [counter,stream] of streams)if(stream.subId===request.subId&&stream.domain===(outbox?'outbox':'relay')){stopStream(counter,false,request.id);return;}
    },
    request,
    ...createPresentationRequests(request),
    destroy(): void {
      disposed = true;
      native.removeEventListener?.('message', android);
      window.removeEventListener('message', ios);
      for (const request of pending.values()) { window.clearTimeout(request.timer); request.reject(); }
      pending.clear();
      for(const stream of streams.values())window.clearTimeout(stream.timer);
      streams.clear();callerIds.clear();uploads.clear();
    },
  });
}
