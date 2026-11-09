import {parseMeshRequest, captureMeshResult, captureMeshDelivery, meshFailure,
  type MeshCaps, type MeshRequest, type MeshResult, type MeshDelivery, type MeshSubscribeRequest} from '../../src/mesh/mesh-contract.ts';
import {routingRecord} from '../../src/routing/routing-contract.ts';
import type {NativeHost} from './native-client.ts';

export type NativeMeshContext = Readonly<{profile: 'paired-lan-v1'; sessionId: string; sourceRevision: string;
  author: string; publishTtl: number; subscribeTtl: number; granted: true}>;
const contexts = new WeakSet<object>(), encoder = new TextEncoder();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Called only on the verified native artifact carrier; structural capture itself grants no authority. */
export function captureNativeMeshContext(value: unknown, generation: string): NativeMeshContext {
  const row = routingRecord(value, ['profile', 'sessionId', 'sourceRevision', 'author', 'publishTtl', 'subscribeTtl', 'granted']);
  if (row.profile !== 'paired-lan-v1' || row.granted !== true || row.sessionId !== generation || typeof row.sourceRevision !== 'string' || !uuid.test(row.sourceRevision) ||
    typeof row.author !== 'string' || !/^[a-f0-9]{64}$/.test(row.author) ||
    ![row.publishTtl, row.subscribeTtl].every(ttl => typeof ttl === 'number' && Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= 255)) throw new Error('Invalid native Mesh context');
  const result = Object.freeze({profile: 'paired-lan-v1' as const, sessionId: generation, sourceRevision: row.sourceRevision, author: row.author,
    publishTtl: row.publishTtl as number, subscribeTtl: row.subscribeTtl as number, granted: true as const}); contexts.add(result); return result;
}
export function isNativeMeshContext(value: unknown, generation: string): value is NativeMeshContext {
  return !!value && typeof value === 'object' && contexts.has(value) && (value as NativeMeshContext).sessionId === generation;
}
type Pending = {request: MeshRequest; deadline: number; timer: number; resolve: (message: MeshResult) => void; reject: (error: Error) => void};
type Stream = {request: MeshSubscribeRequest; sequence: number; delivery: number; deadline: number; timer: number; eose: boolean;
  send: (message: MeshResult | MeshDelivery) => void};
type MeshNative = Readonly<{available(): boolean; capture(value: unknown): MeshRequest; request(value: unknown): Promise<MeshResult>;
  subscribe(value: unknown, send: Stream['send']): void; close(value: unknown): void; destroy(reason?: string): void}>;
class NativeMeshLane {
  private closed = false;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, Stream>();
  private subIds = new Map<string, number>();
  private context: NativeMeshContext | null;
  private sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  private dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  private apply = Reflect.apply;
  constructor(private native: NativeHost, private generation: string, context: NativeMeshContext | undefined,
    private next: () => number, private live: () => boolean) {
    this.context = isNativeMeshContext(context, generation) ? context : null;
    if (this.context) {native.addEventListener?.('message', this.android); window.addEventListener('message', this.ios);}
  }
  available = (): boolean => !this.closed && this.context !== null && this.live();
  private caps(): MeshCaps {
    if (!this.available() || !this.context) throw new Error('Mesh unavailable');
    return Object.freeze({publishTtl: this.context.publishTtl, subscribeTtl: this.context.subscribeTtl});
  }
  private emit(type: string, fields: object): number {
    if (!this.context) throw new Error('Mesh unavailable');
    const sequence = this.next(), encoded = JSON.stringify({type, sessionId: this.generation, sourceRevision: this.context.sourceRevision, sequence, ...fields});
    if (encoder.encode(encoded).length > 32768) throw new Error('Mesh request too large');
    this.native.postMessage(encoded); return sequence;
  }
  capture = (value: unknown): MeshRequest => parseMeshRequest(value, this.caps());
  request = (value: unknown): Promise<MeshResult> => {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      try {
        const request = this.capture(value);
        if (request.type === 'mesh.close' || request.type === 'mesh.subscribe' || this.pending.size + this.startingStreams() >= 4) throw new Error('Mesh request unavailable');
        const deadline = started + (request.type === 'mesh.blobs' ? 3000 : 15000), sequence = this.next();
        const timeoutMs = Math.floor(deadline - performance.now()); if (timeoutMs <= 0 || !this.available()) throw new Error('Mesh request timed out');
        const encoded = JSON.stringify({type: 'mesh', sessionId: this.generation, sourceRevision: this.context!.sourceRevision, sequence, message: JSON.stringify(request), timeoutMs});
        if (encoder.encode(encoded).length > 32768) throw new Error('Mesh request too large');
        const timer = window.setTimeout(() => {if (this.pending.delete(sequence)) reject(new Error('Mesh request timed out; outcome unconfirmed'));}, timeoutMs);
        this.pending.set(sequence, {request, deadline, timer, resolve, reject});
        try {this.native.postMessage(encoded);} catch {this.pending.delete(sequence); window.clearTimeout(timer); reject(new Error('Mesh native bridge unavailable'));}
      } catch {reject(new Error('Mesh request unavailable'));}
    });
  };
  subscribe = (value: unknown, send: Stream['send']): void => {
    const started = performance.now(); let request: MeshRequest | undefined;
    try {
      request = this.capture(value);
      if (request.type !== 'mesh.subscribe' || this.streams.size >= 4 || this.pending.size + this.startingStreams() >= 4 || this.subIds.has(request.subId)) throw new Error('Mesh subscription unavailable');
      const sequence = this.next(), deadline = started + 15000, timeoutMs = Math.floor(deadline - performance.now());
      if (timeoutMs <= 0 || !this.available()) throw new Error('Mesh subscription timed out');
      const timer = window.setTimeout(() => this.stopStream(sequence, 'Mesh subscription timed out', true), timeoutMs);
      const stream: Stream = {request, sequence, delivery: 0, deadline, timer, eose: false, send};
      this.streams.set(sequence, stream); this.subIds.set(request.subId, sequence);
      try {this.native.postMessage(JSON.stringify({type: 'mesh', sessionId: this.generation, sourceRevision: this.context!.sourceRevision,
        sequence, message: JSON.stringify(request), timeoutMs}));}
      catch {this.streams.delete(sequence); this.subIds.delete(request.subId); window.clearTimeout(timer); throw new Error('Mesh native bridge unavailable');}
    } catch {const failure = meshFailure(request ?? value, 'Mesh subscription unavailable'); if (failure) send(failure);}
  };
  private startingStreams(): number {return Array.from(this.streams.values()).filter(stream => !stream.eose).length;}
  close = (value: unknown): void => {
    let request: MeshRequest; try {request = this.capture(value);} catch {return;}
    if (request.type !== 'mesh.close') return;
    const sequence = this.subIds.get(request.subId); if (sequence === undefined) return;
    this.stopStream(sequence, undefined, true);
  };
  private stopStream(sequence: number, reason: string | undefined, tellNative: boolean): void {
    const stream = this.streams.get(sequence); if (!stream) return;
    this.streams.delete(sequence); this.subIds.delete(stream.request.subId); window.clearTimeout(stream.timer);
    if (tellNative && this.available()) try {this.emit('mesh', {message: JSON.stringify({type: 'mesh.close', subId: stream.request.subId}), timeoutMs: 15000});} catch { /* Native source/stream lifetime remains authoritative. */ }
    if (reason !== undefined) stream.send(Object.freeze({type: 'mesh.closed', subId: stream.request.subId, reason}));
  }
  private android = (event: {data: unknown}): void => this.receive(event.data);
  private ios = (event: MessageEvent): void => {
    if (!event.isTrusted || !this.sourceGetter || !this.dataGetter) return;
    try {if (this.apply(this.sourceGetter, event, []) !== window) return;
      const data = routingRecord(this.apply(this.dataGetter, event, []), ['type', 'message']);
      if (data.type === 'hypergolic.native-response') this.receive(data.message);
    } catch { /* A guest/sibling cannot impersonate the owning native window. */ }
  };
  private receive(raw: unknown): void {
    if (!this.available() || typeof raw !== 'string' || encoder.encode(raw).length > 32768) return;
    try {
      const row = routingRecord(JSON.parse(raw), ['type', 'sessionId', 'sourceRevision'], ['sequence', 'response', 'delivery', 'phase', 'reason']);
      if (row.sessionId !== this.generation || row.sourceRevision !== this.context!.sourceRevision) return;
      if (row.type === 'mesh.revoked') {routingRecord(row, ['type', 'sessionId', 'sourceRevision'], ['reason']); this.destroy('Mesh source revoked'); return;}
      if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1) return;
      if (row.type === 'mesh.response') {routingRecord(row, ['type', 'sessionId', 'sourceRevision', 'sequence', 'response']); this.response(row.sequence as number, row.response);}
      else if (row.type === 'mesh.stream') {routingRecord(row, ['type', 'sessionId', 'sourceRevision', 'sequence', 'delivery', 'phase', 'response']); this.delivery(row as {sequence: number; delivery: number; phase: unknown; response: unknown});}
    } catch { /* Invalid envelopes have no recipient or authority. */ }
  }
  private response(sequence: number, response: unknown): void {
    const row = this.pending.get(sequence), stream = this.streams.get(sequence);
    if (!row && !stream) return;
    if (stream) {
      try {
        if (performance.now() >= stream.deadline || typeof response !== 'string') throw new Error('Mesh subscription refused');
        const result = captureMeshResult(JSON.parse(response), stream.request);
        if (result.type !== 'mesh.subscribe.result' || !this.available()) throw new Error('Invalid Mesh refusal');
        this.stopStream(sequence, undefined, false); stream.send(result);
      } catch {this.stopStream(sequence, 'Invalid Mesh refusal', true);} return;
    }
    this.pending.delete(sequence); window.clearTimeout(row!.timer);
    try {
      if (performance.now() >= row!.deadline || typeof response !== 'string') throw new Error('Mesh request unavailable');
      const reply = captureMeshResult(JSON.parse(response), row!.request, this.context!.author);
      if (!this.available() || performance.now() >= row!.deadline) throw new Error('Mesh request expired'); row!.resolve(reply);
    } catch {row!.reject(new Error('Invalid or expired Mesh result'));}
  }
  private delivery(envelope: {sequence: number; delivery: number; phase: unknown; response: unknown}): void {
    const stream = this.streams.get(envelope.sequence); if (!stream) return;
    try {
      if (!Number.isSafeInteger(envelope.delivery) || envelope.delivery !== stream.delivery + 1 ||
        !['stored', 'live'].includes(envelope.phase as string) || typeof envelope.response !== 'string' || !stream.eose && performance.now() >= stream.deadline) throw new Error('Invalid Mesh delivery');
      const message = captureMeshDelivery(JSON.parse(envelope.response), stream.request, envelope.phase as 'stored' | 'live');
      if (!this.available() || !stream.eose && performance.now() >= stream.deadline) throw new Error('Mesh source expired');
      if (message.type === 'mesh.eose') {if (stream.eose) throw new Error('Duplicate Mesh EOSE'); stream.eose = true; window.clearTimeout(stream.timer);}
      stream.delivery = envelope.delivery;
      if (message.type === 'mesh.closed') this.stopStream(stream.sequence, undefined, false);
      stream.send(message);
      if (this.available()) this.emit('mesh.ack', {streamSequence: stream.sequence, delivery: envelope.delivery});
    } catch {this.stopStream(stream.sequence, 'Invalid Mesh delivery', true);}
  }
  destroy = (reason = 'Mesh source closed'): void => {
    if (this.closed) return; this.closed = true;
    this.native.removeEventListener?.('message', this.android); window.removeEventListener('message', this.ios);
    for (const row of this.pending.values()) {window.clearTimeout(row.timer); row.reject(new Error(reason));} this.pending.clear();
    for (const sequence of Array.from(this.streams.keys())) this.stopStream(sequence, reason, false);
    if (this.context) try {this.emit('mesh.dispose', {});} catch { /* Native view/source destruction must independently revoke. */ }
  };
}
/** Absent/unbranded context is unavailable and sends no Mesh operation. Shares only sequence ownership. */
export function createMeshNative(native: NativeHost, generation: string, context: NativeMeshContext | undefined,
  next: () => number, live: () => boolean): MeshNative {
  const lane = new NativeMeshLane(native, generation, context, next, live);
  return Object.freeze({available: lane.available, capture: lane.capture, request: lane.request, subscribe: lane.subscribe, close: lane.close, destroy: lane.destroy});
}
/** Parent-owned endpoint. Source identity plus live registration, never opaque origin text, binds each call/reply. */
export function createMeshGuestReceiver(frame: HTMLIFrameElement, source: Window, native: MeshNative, live: () => boolean) {
  let closed = false;
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get, apply = Reflect.apply;
  const current = () => !closed && live() && frame.contentWindow === source;
  const send = (message: MeshResult | MeshDelivery): void => {
    if (current() && (native.available() || message.type === 'mesh.closed' || 'error' in message)) source.postMessage(message, '*');
  };
  const close = (): void => {if (closed) return; closed = true; observer.disconnect(); native.destroy('Mesh source closed');};
  const observer = new MutationObserver(() => {if (!frame.isConnected || frame.contentWindow !== source) close();});
  observer.observe(document, {childList: true, subtree: true});
  return Object.freeze({
    receive(event: MessageEvent): boolean {
      if (!event.isTrusted || !sourceGetter || !dataGetter) return false;
      let input: unknown;
      try {if (apply(sourceGetter, event, []) !== source || frame.contentWindow !== source) return false; input = apply(dataGetter, event, []);} catch {return false;}
      const type = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'type')?.value : undefined;
      if (typeof type !== 'string' || !type.startsWith('mesh.')) return false;
      if (!current()) return true;
      let request: MeshRequest | undefined;
      try {request = native.capture(input);} catch {const failure = meshFailure(input, 'Invalid Mesh request'); if (failure) send(failure);}
      if (!request) return true;
      if (request.type === 'mesh.close') native.close(request);
      else if (request.type === 'mesh.subscribe') native.subscribe(request, send);
      else void native.request(request).then(send, () => {const failure = meshFailure(request, 'Mesh request unavailable or outcome unconfirmed'); if (failure) send(failure);});
      return true;
    },
    close,
  });
}
