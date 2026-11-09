type MeshMessage = Record<string, unknown>;
type MeshHandler = (value: unknown) => void;
type MeshTopic = 'event' | 'eose' | 'closed';
type MeshSubscription = {subId: string; requestId?: string; posted: boolean; closed: boolean; eose: boolean;
  reason?: string; ttl?: number; handlers: Map<MeshTopic, Set<MeshHandler>>};
type MeshPending = {id: string; type: string; timer: number; resolve: (reply: MeshMessage) => void;
  reject: (error: Error) => void; subscription?: MeshSubscription};

/** Each factory is serialized into the eager prelude; no module closure crosses into the guest. */
function createMeshCodec() {
  const stringify = JSON.stringify.bind(JSON), descriptors = Object.getOwnPropertyDescriptors.bind(Object), encode = new TextEncoder();
  const error = (reason = 'Invalid Mesh message'): never => {throw new Error(reason);};
  function capture(value: unknown, maximum = 8192): unknown {
    let nodes = 0, bytes = 0;
    const consume = (count: number): void => {bytes += count; if (bytes > maximum) return error();};
    const seen = new Set<object>();
    function clone(item: unknown, depth: number): unknown {
      if (++nodes > 8192 || depth > 8) return error();
      if (item === null || typeof item === 'boolean') {consume(encode.encode(stringify(item)).length); return item;}
      if (typeof item === 'string') {if (item.length > maximum) return error(); consume(encode.encode(stringify(item)).length); return item;}
      if (typeof item === 'number') {if (!Number.isSafeInteger(item)) return error(); consume(stringify(item).length); return item;}
      if (!item || typeof item !== 'object' || seen.has(item)) return error();
      seen.add(item); const own = descriptors(item); let result: unknown;
      if (Array.isArray(item)) {
        const length = own.length?.value;
        if (Object.getPrototypeOf(item) !== Array.prototype || !Number.isSafeInteger(length) || length > 8192 ||
          Reflect.ownKeys(own).length !== length + 1) return error();
        consume(2 + Math.max(0, length - 1));
        result = Object.freeze(Array.from({length}, (_, i) => {
          const field = own[String(i)]; if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return error();
          return clone(field.value, depth + 1);
        }));
      } else {
        if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(own).length > 256) return error();
        consume(2 + Math.max(0, Reflect.ownKeys(own).length - 1));
        result = Object.freeze(Object.fromEntries(Reflect.ownKeys(own).map(key => {
          const field = own[key as string];
          if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value') || !field.enumerable) return error();
          if (key.length > maximum) return error(); consume(encode.encode(stringify(key)).length + 1);
          return [key, clone(field.value, depth + 1)];
        })));
      }
      seen.delete(item); return result;
    }
    const result = clone(value, 0); if (encode.encode(stringify(result)).length > maximum) return error(); return result;
  }
  function record(value: unknown, required: string[], optional: string[] = []): MeshMessage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return error();
    const row = value as MeshMessage, allowed = new Set([...required, ...optional]);
    if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !allowed.has(key))) return error();
    return row;
  }
  const whole = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const reasonText = (value: unknown, nonempty = true): string => {if (typeof value !== 'string' || nonempty && !value.length || encode.encode(value).length > 512) return error(); return value;};
  const notify = (handler: MeshHandler, value: unknown): void => {try {handler(value);} catch { /* Publisher callbacks are independent. */ }};
  return {capture, record, whole, reasonText, notify, error, stringify, encode};
}
function createMeshValues(codec: ReturnType<typeof createMeshCodec>) {
  const {capture, record, whole, reasonText, error, stringify, encode} = codec;
  function options(value: unknown): MeshMessage {
    const row = record(capture(value === undefined ? {} : value), [], ['ttl']);
    if (row.ttl !== undefined && !whole(row.ttl, 255)) return error(); return row;
  }
  function signedEvent(value: unknown): MeshMessage {
    const row = record(value, ['id', 'pubkey', 'kind', 'content', 'tags', 'created_at', 'sig']);
    if (typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || typeof row.pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(row.pubkey) ||
      typeof row.sig !== 'string' || !/^[a-f0-9]{128}$/.test(row.sig) || !whole(row.kind, 65535) || !whole(row.created_at) ||
      typeof row.content !== 'string' || !Array.isArray(row.tags) || row.tags.length > 256 ||
      row.tags.some(tag => !Array.isArray(tag) || tag.length > 64 || tag.some(item => typeof item !== 'string')) ||
      encode.encode(stringify(['EVENT', row])).length > 8192) return error();
    return row;
  }
  function publishResult(reply: MeshMessage, requestedTtl: unknown): MeshMessage {
    if (reply.ok === false) {record(reply, ['type', 'id', 'ok', 'error']); return Object.freeze({ok: false, error: reasonText(reply.error)});}
    record(reply, ['type', 'id', 'ok'], ['event', 'eventId', 'ttl']); if (reply.ok !== true) return error();
    const event = reply.event === undefined ? undefined : signedEvent(reply.event);
    if (reply.eventId !== undefined && (typeof reply.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(reply.eventId) || event && event.id !== reply.eventId)) return error();
    if (reply.ttl !== undefined && (!whole(reply.ttl, 255) || typeof requestedTtl === 'number' && reply.ttl > requestedTtl)) return error();
    return Object.freeze({ok: true, ...(event ? {event} : {}), ...(reply.eventId === undefined ? {} : {eventId: reply.eventId}), ...(reply.ttl === undefined ? {} : {ttl: reply.ttl})});
  }
  return {options, signedEvent, publishResult};
}
function createMeshWire(timeoutMs: number, codec: ReturnType<typeof createMeshCodec>) {
  const {capture, record, error} = codec;
  const guest = window as Window & {napplet?: {shell?: {ready(): Promise<unknown>}; mesh?: object}};
  const parentWindow = window.parent, post = parentWindow.postMessage.bind(parentWindow), apply = Reflect.apply;
  const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  const schedule = window.setTimeout.bind(window), unschedule = window.clearTimeout.bind(window), pending = new Map<string, MeshPending>();
  let closed = false, next = 0;
  function identifier(): string {
    if (next >= Number.MAX_SAFE_INTEGER) return error('Mesh ID limit exceeded');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return 'mesh-' + (++next) + '-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function remove(id?: string): MeshPending | undefined {
    if (id === undefined) return; const row = pending.get(id); if (row) {pending.delete(id); unschedule(row.timer);} return row;
  }
  function enqueue(type: string, fields: MeshMessage, callbacks: Pick<MeshPending, 'resolve' | 'reject'>, subscription?: MeshSubscription): void {
    const {resolve, reject} = callbacks;
    if (closed || pending.size >= 4) {reject(new Error('Mesh request limit exceeded or page closed')); return;}
    const id = identifier(), message = capture({...fields, type, id}) as MeshMessage;
    const row: MeshPending = {id, type, resolve, reject, timer: schedule(() => {
      if (!remove(id)) return;
      reject(new Error(subscription ? 'Mesh subscription timed out' : 'Mesh request timed out'));
    }, timeoutMs), ...(subscription ? {subscription} : {})};
    if (subscription) subscription.requestId = id; pending.set(id, row);
    void Promise.resolve().then(() => {
      const shell = guest.napplet?.shell; if (!shell || typeof shell.ready !== 'function') return error('Mesh bootstrap unavailable');
      return shell.ready();
    }).then(() => {
      if (closed || pending.get(id) !== row || subscription?.closed) return;
      if (subscription) subscription.posted = true;
      try {post(message, '*');} catch {remove(id); reject(new Error('Mesh page closed'));}
    }, () => {if (remove(id)) reject(new Error('Mesh bootstrap unavailable'));});
  }
  const request = (type: string, fields: MeshMessage): Promise<MeshMessage> => new Promise((resolve, reject) => {
    try {enqueue(type, fields, {resolve, reject});} catch {reject(new Error('Invalid Mesh request'));}
  });
  function read(event: MessageEvent): MeshMessage | null {
    if (closed || !event.isTrusted || !sourceGetter || !dataGetter) return null;
    try {if (apply(sourceGetter, event, []) !== parentWindow) return null;
      return record(capture(apply(dataGetter, event, []), 16384), ['type'], ['id', 'subId', 'ok', 'error', 'online', 'peers', 'limits', 'event', 'eventId', 'ttl', 'blobs', 'result', 'reason']);
    } catch {return null;}
  }
  function settle(reply: MeshMessage): void {
    if (typeof reply.id !== 'string') return; const row = pending.get(reply.id);
    if (row && reply.type === row.type + '.result') {remove(row.id); row.resolve(reply);}
  }
  const beginClose = (): boolean => {if (closed) return false; closed = true; return true;};
  const rejectAll = (): void => {for (const row of pending.values()) {unschedule(row.timer); row.reject(new Error('Mesh page closed'));} pending.clear();};
  return {guest, post, identifier, remove, enqueue, request, read, settle, beginClose, rejectAll, isClosed: () => closed};
}
function createMeshStreams(wire: ReturnType<typeof createMeshWire>, codec: ReturnType<typeof createMeshCodec>, values: ReturnType<typeof createMeshValues>) {
  const {record, reasonText, whole, notify, error} = codec, rows = new Map<string, MeshSubscription>();
  function end(row: MeshSubscription, reason?: string, tellParent = false): void {
    if (row.closed) return; row.closed = true; if (reason !== undefined) row.reason = reason;
    wire.remove(row.requestId); rows.delete(row.subId);
    const handlers = Array.from(row.handlers.get('closed') ?? []); row.handlers.clear();
    if (tellParent && row.posted) try {wire.post({type: 'mesh.close', subId: row.subId}, '*');} catch { /* Native source lifetime owns teardown. */ }
    for (const handler of handlers) notify(handler, reason);
  }
  function receive(reply: MeshMessage): boolean {
    if (reply.type !== 'mesh.event' && reply.type !== 'mesh.eose' && reply.type !== 'mesh.closed') return false;
    if (typeof reply.subId !== 'string') return true; const row = rows.get(reply.subId); if (!row || row.closed) return true;
    try {
      if (reply.type === 'mesh.closed') {record(reply, ['type', 'subId'], ['reason']); end(row, reply.reason === undefined ? undefined : reasonText(reply.reason, false)); return true;}
      let value: unknown, topic: MeshTopic;
      if (reply.type === 'mesh.eose') {
        record(reply, ['type', 'subId', 'ttl']); if (row.eose) return true;
        if (!whole(reply.ttl, 255) || row.ttl !== undefined && reply.ttl > row.ttl) return error();
        row.eose = true; wire.remove(row.requestId); value = reply.ttl; topic = 'eose';
      } else {record(reply, ['type', 'subId', 'result']); const result = record(reply.result, ['event']); values.signedEvent(result.event); value = result; topic = 'event';}
      for (const handler of Array.from(row.handlers.get(topic) ?? [])) {if (row.closed) break; notify(handler, value);}
    } catch {end(row, 'Invalid Mesh delivery', true);} return true;
  }
  function refuse(row: MeshSubscription, reply: MeshMessage): void {
    try {record(reply, ['type', 'id', 'error']); end(row, reasonText(reply.error));} catch {end(row, 'Invalid Mesh refusal', true);}
  }
  const close = (): void => {for (const row of Array.from(rows.values())) end(row, 'Mesh page closed', true);};
  return {rows, end, receive, refuse, close};
}
function createMeshFacade(wire: ReturnType<typeof createMeshWire>, streams: ReturnType<typeof createMeshStreams>, codec: ReturnType<typeof createMeshCodec>, values: ReturnType<typeof createMeshValues>) {
  const {capture, record, whole, reasonText, notify, error} = codec;
  return Object.freeze({
    async info() {
      const reply = await wire.request('mesh.info', {});
      if (reply.error !== undefined) {record(reply, ['type', 'id', 'error']); throw new Error(reasonText(reply.error));}
      record(reply, ['type', 'id', 'online', 'peers', 'limits']); const limits = record(reply.limits, ['publishTtl', 'subscribeTtl']);
      if (typeof reply.online !== 'boolean' || !whole(reply.peers) || !reply.online && reply.peers !== 0 || !whole(limits.publishTtl, 255) || !whole(limits.subscribeTtl, 255)) return error();
      return Object.freeze({online: reply.online, peers: reply.peers, limits});
    },
    publish(template: unknown, suppliedOptions?: unknown) {
      try {const event = record(capture(template), ['kind', 'content'], ['tags', 'created_at']), options = values.options(suppliedOptions);
        return wire.request('mesh.publish', {event, ...options}).then(reply => values.publishResult(reply, options.ttl)).catch(failure => Object.freeze({ok: false, error: failure instanceof Error ? failure.message : 'Mesh publish failed'}));
      } catch {return Promise.resolve(Object.freeze({ok: false, error: 'Invalid Mesh publish'}));}
    },
    subscribe(filters: unknown, suppliedOptions?: unknown) {
      const row: MeshSubscription = {subId: wire.identifier(), posted: false, closed: false, eose: false, handlers: new Map()};
      const handle = Object.freeze({
        on(topic: MeshTopic, handler: MeshHandler) {
          if (!['event', 'eose', 'closed'].includes(topic) || typeof handler !== 'function') return error('Invalid Mesh listener');
          if (row.closed) {if (topic === 'closed') notify(handler, row.reason); return {close() {}};}
          const handlers = row.handlers.get(topic) ?? new Set<MeshHandler>();
          if (!handlers.has(handler) && Array.from(row.handlers.values()).reduce((sum, set) => sum + set.size, 0) >= 16) return error('Mesh listener limit exceeded');
          row.handlers.set(topic, handlers); handlers.add(handler); return {close() {handlers.delete(handler);}};
        },
        close() {streams.end(row, undefined, true);},
      });
      try {
        if (wire.isClosed() || streams.rows.size >= 4) return error('Mesh subscription limit exceeded or page closed');
        const capturedFilters = capture(Array.isArray(filters) ? filters : [filters]);
        if (!Array.isArray(capturedFilters) || !capturedFilters.length || capturedFilters.length > 4) return error();
        const options = values.options(suppliedOptions); if (typeof options.ttl === 'number') row.ttl = options.ttl;
        streams.rows.set(row.subId, row);
        wire.enqueue('mesh.subscribe', {subId: row.subId, filters: capturedFilters, ...options}, {
          resolve: reply => streams.refuse(row, reply), reject: failure => streams.end(row, failure.message, true),
        }, row);
      } catch {streams.end(row, 'Invalid Mesh subscription');}
      return handle;
    },
    async blobs(hashes: unknown) {
      const input = capture(hashes);
      if (!Array.isArray(input) || input.length > 64 || input.some(hash => typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash))) return error();
      const capturedHashes = Object.freeze([...new Set((input as string[]).map(hash => hash.toLowerCase()))]);
      const reply = await wire.request('mesh.blobs', {hashes: capturedHashes});
      if (reply.error !== undefined) {record(reply, ['type', 'id', 'error']); throw new Error(reasonText(reply.error));}
      record(reply, ['type', 'id', 'peers', 'blobs']); const blobs = record(reply.blobs, [...capturedHashes]);
      if (!whole(reply.peers) || Object.values(blobs).some(count => !whole(count, reply.peers as number))) return error();
      return Object.freeze({peers: reply.peers, blobs});
    },
  });
}
function installMeshFacade(timeoutMs: number, factories: readonly [typeof createMeshCodec, typeof createMeshValues, typeof createMeshWire, typeof createMeshStreams, typeof createMeshFacade]): void {
  const [codecFactory, valueFactory, wireFactory, streamFactory, facadeFactory] = factories;
  const codec = codecFactory(), values = valueFactory(codec), wire = wireFactory(timeoutMs, codec), streams = streamFactory(wire, codec, values);
  const receive = (event: MessageEvent): void => {const reply = wire.read(event); if (reply && !streams.receive(reply)) wire.settle(reply);};
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', () => {
    if (!wire.beginClose()) return; window.removeEventListener('message', receive); streams.close(); wire.rejectAll();
  }, {once: true});
  wire.guest.napplet = {...wire.guest.napplet, mesh: facadeFactory(wire, streams, codec, values)};
}
/** This helper alone advertises nothing; a reviewed-grant caller must opt into insertion. */
export function injectMeshFacade(html: string, options: Readonly<{timeoutMs?: number}> = {}): string {
  const timeout = options.timeoutMs ?? 17000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 17000) throw new Error('Invalid Mesh local timeout');
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw new Error('Mesh binding requires host CSP');
  const factories = [createMeshCodec, createMeshValues, createMeshWire, createMeshStreams, createMeshFacade].map(factory => `(${factory.toString()})`).join(',');
  return html.replace(head, value => `${value}<script>(${installMeshFacade.toString()})(${timeout},[${factories}]);</script>`);
}
