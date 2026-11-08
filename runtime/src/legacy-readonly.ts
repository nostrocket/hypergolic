import {parseRelaySubscribe, type RelaySubscribeRequest, type RelayCloseRequest, type RelaySubscriptionMessage} from '../../src/network/relay-subscription-contract';
import {normalizeRelayUrl} from '../../src/network/relay-settings';

type Subscription = {nativeId: string; callerId: string; closed: boolean};
type Socket = {relay: string; subscriptions: Map<string, Subscription>};
export type LegacyReadOnlyOptions = Readonly<{
  frame: HTMLIFrameElement; source: Window; session: string;
  live(): boolean;
  subscribe(request: RelaySubscribeRequest, deliver: (message: RelaySubscriptionMessage) => void): void;
  close(request: RelayCloseRequest): void;
  status(message: string): void;
}>;
/** This adapter is created only after a native attested, exact-pin compatibility grant. */
export function createLegacyReadOnlyReceiver(options: LegacyReadOnlyOptions) {
  const {frame, source, session} = options;
  const sockets = new Map<string, Socket>();
  let closed = false, next = 0, count = 0, windowStart = performance.now();
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  const live = (): boolean => !closed && options.live() && frame.contentWindow === source;
  const send = (socket: string, fields: object): void => {if (live()) source.postMessage({type: 'legacy.readonly.result', session, socket, ...fields}, '*');};
  const notice = (socket: string, message: string): void => {options.status(message); send(socket, {event: 'message', data: JSON.stringify(['NOTICE', message])});};
  function closeSubscription(socket: Socket, row: Subscription): void {
    if (row.closed) return;
    row.closed = true; socket.subscriptions.delete(row.callerId);
    try {options.close({type: 'relay.close', id: 'legacy-close-' + (++next), subId: row.nativeId});} catch { /* Native source teardown also revokes reads. */ }
  }
  function closeSocket(id: string): void {
    const socket = sockets.get(id); if (!socket) return;
    sockets.delete(id);
    const closing = Array.from(socket.subscriptions.values());
    for (const row of closing) closeSubscription(socket, row);
  }
  function deliver(id: string, socket: Socket, row: Subscription, message: RelaySubscriptionMessage): void {
    if (!live() || sockets.get(id) !== socket || row.closed || socket.subscriptions.get(row.callerId) !== row || message.subId !== row.nativeId) return;
    if (message.type === 'relay.event') send(id, {event: 'message', data: JSON.stringify(['EVENT', row.callerId, message.result.event])});
    else if (message.type === 'relay.eose') send(id, {event: 'message', data: JSON.stringify(['EOSE', row.callerId])});
    else if (message.type === 'relay.closed') {
      row.closed = true; socket.subscriptions.delete(row.callerId);
      const reason = 'Legacy read limited: ' + (message.reason ?? 'subscription closed');
      options.status(reason); send(id, {event: 'message', data: JSON.stringify(['CLOSED', row.callerId, reason])});
    }
  }
  function read(id: string, socket: Socket, data: unknown): void {
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > 16384) throw new Error('Invalid read frame');
    const wire: unknown = JSON.parse(data);
    if (!Array.isArray(wire) || typeof wire[1] !== 'string' || !wire[1] || wire[1].length > 128 || /[\u0000-\u001f\u007f]/.test(wire[1])) throw new Error('Invalid read frame');
    const callerId = wire[1];
    // No arbitrary capability or native operation name ever crosses this dispatch.
    if (wire[0] === 'CLOSE' && wire.length === 2) {const row = socket.subscriptions.get(callerId); if (row) closeSubscription(socket, row); return;}
    if (wire[0] !== 'REQ' || wire.length < 3 || wire.length > 6) throw new Error('Read-only mode denies publishing, AUTH and all non-read operations');
    if (next >= 4096) throw new Error('Legacy lifetime request limit');
    const nativeId = 'legacy-' + (++next);
    const request = parseRelaySubscribe({type: 'relay.subscribe', id: nativeId, subId: nativeId, filters: wire.slice(2), relay: socket.relay});
    const old = socket.subscriptions.get(callerId); if (old) closeSubscription(socket, old);
    if (Array.from(sockets.values()).reduce((total, item) => total + item.subscriptions.size, 0) >= 3) throw new Error('Legacy read limited to three active subscriptions');
    if (wire.slice(2).some(filter => filter && typeof filter === 'object' && (!('limit' in filter) || typeof filter.limit === 'number' && filter.limit > 32))) notice(id, 'Partial legacy history: at most 32 stored events per filter; current native relay policy applies');
    if (!live() || sockets.get(id) !== socket) throw new Error('Legacy session closed');
    const row: Subscription = {nativeId, callerId, closed: false}; socket.subscriptions.set(callerId, row);
    try {options.subscribe(request, message => deliver(id, socket, row, message));}
    catch {closeSubscription(socket, row); throw new Error('Legacy read unavailable');}
  }
  function receive(event: MessageEvent): boolean {
    if (!live() || !event.isTrusted || !sourceGetter || !dataGetter) return false;
    try {
      if (Reflect.apply(sourceGetter, event, []) !== source) return false;
      const value = Reflect.apply(dataGetter, event, []) as Record<string, unknown>;
      if (value?.type !== 'legacy.readonly') return false;
      if (value.session !== session || typeof value.socket !== 'string' || !/^socket-[1-9][0-9]{0,3}$/.test(value.socket)) return true;
      if (performance.now() - windowStart > 1000) {count = 0; windowStart = performance.now();}
      if (++count > 64) {destroy(); return true;}
      const id = value.socket;
      try {
        if (value.operation === 'open' && Object.keys(value).length === 5) {
          if (sockets.has(id) || sockets.size >= 4 || typeof value.url !== 'string') throw new Error('Legacy socket limit');
          const relay = normalizeRelayUrl(value.url); sockets.set(id, {relay, subscriptions: new Map()}); send(id, {event: 'open'});
        } else if (value.operation === 'close' && Object.keys(value).length === 4) closeSocket(id);
        else if (value.operation === 'send' && Object.keys(value).length === 5) {
          const socket = sockets.get(id); if (!socket) return true;
          read(id, socket, value.data);
        } else throw new Error('Read-only operation denied');
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Legacy read denied';
        notice(id, reason);
        // Failed REQs must not masquerade as complete history.
        if (value.operation === 'send' && typeof value.data === 'string') {
          try {const wire = JSON.parse(value.data); if (wire[0] === 'REQ' && typeof wire[1] === 'string') send(id, {event: 'message', data: JSON.stringify(['CLOSED', wire[1], reason])});} catch { /* Invalid frame has no subscription. */ }
        }
      }
      return true;
    } catch {options.status('Invalid legacy message denied'); destroy();}
    return true;
  }
  function destroy(): void {if (closed) return; const closing = Array.from(sockets.keys()); for (const id of closing) {send(id, {event: 'close', reason: 'Legacy session closed'}); closeSocket(id);} closed = true;}
  return Object.freeze({receive, destroy});
}
