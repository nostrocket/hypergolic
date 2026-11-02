import type { HostOperationContext, NappletMessage } from '@kehto/runtime';
import { parseRoutingMessage, routingRecord, routingText, routingPayload, ROUTING_LIMITS, routingRole, stableConvention, type RoutingMessage } from '../../src/routing/routing-contract';
import { NativeRequestRevoked, type createNativeClient } from './native-client';
function capturedMessage(row: Record<string, unknown>): NappletMessage {
  const captured = routingRecord(routingPayload(row), ['type'], Object.keys(row).filter(key => key !== 'type'));
  return Object.freeze({...captured, type: routingText(captured.type, 128)});
}
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function candidate(value: unknown): void {
  const row = routingRecord(value, ['dTag', 'actions', 'conventions'], ['title', 'isDefault']);
  routingText(row.dTag, ROUTING_LIMITS.handler);
  if (owns(row, 'title')) routingText(row.title, 128);
  if (owns(row, 'isDefault') && typeof row.isDefault !== 'boolean') throw new Error('Invalid default');
  if (!Array.isArray(row.actions) || !Array.isArray(row.conventions) || row.actions.length > 16 || row.conventions.length > 16) throw new Error('Invalid handler');
  row.actions.forEach(routingRole); row.conventions.forEach(stableConvention);
}
function availability(value: unknown): void {
  const row = routingRecord(value, ['archetype', 'available', 'candidates', 'hasDefault']);
  routingRole(row.archetype);
  if (typeof row.available !== 'boolean' || typeof row.hasDefault !== 'boolean' || !Array.isArray(row.candidates) || row.candidates.length > 64) throw new Error('Invalid availability');
  row.candidates.forEach(candidate);
}
export function captureRoutingPush(value: unknown): NappletMessage {
  const input = routingRecord(value, ['type'], ['topic', 'sender', 'payload', 'channelId', 'peer', 'reason', 'availability']);
  if (input.type === 'inc.event' || input.type === 'inc.channel.event') {
    const row = routingRecord(value, ['type', input.type === 'inc.event' ? 'topic' : 'channelId', 'sender'], ['payload']);
    routingText(row.sender, ROUTING_LIMITS.handler);
    routingText(row[input.type === 'inc.event' ? 'topic' : 'channelId'], input.type === 'inc.event' ? ROUTING_LIMITS.topic : ROUTING_LIMITS.id);
    if (owns(row, 'payload')) row.payload = routingPayload(row.payload);
    return Object.freeze({...row, type: input.type});
  }
  if (input.type === 'inc.channel.opened') {
    const row = routingRecord(value, ['type', 'channelId', 'peer']); routingText(row.channelId, ROUTING_LIMITS.id); routingText(row.peer, ROUTING_LIMITS.handler); return Object.freeze({...row, type: input.type});
  }
  if (input.type === 'inc.channel.closed') {
    const row = routingRecord(value, ['type', 'channelId'], ['reason']); routingText(row.channelId, ROUTING_LIMITS.id); if (owns(row, 'reason')) routingText(row.reason, 256); return Object.freeze({...row, type: input.type});
  }
  if (input.type === 'intent.changed') {
    const row = routingRecord(value, ['type', 'availability']); availability(row.availability); return capturedMessage(row);
  }
  throw new Error('Invalid routing event');
}
export function captureRoutingReply(value: unknown, request: RoutingMessage): NappletMessage | null {
  if (request.id === undefined) { if (value !== null) throw new Error('Unexpected emission receipt'); return null; }
  const row = routingRecord(value, ['type', 'id'], ['result', 'availability', 'handlers', 'channelId', 'peer', 'channels', 'error']);
  if (row.type !== request.type + '.result' || row.id !== request.id) throw new Error('Routing response mismatch');
  if (owns(row, 'error')) routingText(row.error, 256);
  if (request.type === 'intent.invoke') {
    routingRecord(row, ['type', 'id', 'result'], ['error']);
    const result = routingRecord(row.result, ['ok', 'archetype', 'action', 'handled'], ['handler', 'windowId', 'convention', 'error']);
    if (typeof result.ok !== 'boolean' || typeof result.handled !== 'boolean' || result.archetype !== request.request!.archetype || result.action !== request.request!.action) throw new Error('Invalid intent result');
    for (const field of ['handler', 'windowId', 'error']) if (owns(result, field)) routingText(result[field], field === 'handler' ? ROUTING_LIMITS.handler : field === 'error' ? 256 : ROUTING_LIMITS.id);
    if (owns(result, 'convention')) stableConvention(result.convention);
  } else if (request.type === 'intent.available') { routingRecord(row, ['type', 'id', 'availability'], ['error']); availability(row.availability); if ((row.availability as { archetype: string }).archetype !== request.archetype) throw new Error('Invalid archetype'); }
  else if (request.type === 'intent.handlers') { routingRecord(row, ['type', 'id', 'handlers'], ['error']); if (!Array.isArray(row.handlers) || row.handlers.length > 1024) throw new Error('Invalid handlers'); row.handlers.forEach(availability); }
  else if (request.type === 'inc.subscribe') routingRecord(row, ['type', 'id'], ['error']);
  else if (request.type === 'inc.channel.open') { routingRecord(row, ['type', 'id'], ['channelId', 'peer', 'error']); if (!owns(row, 'error')) { routingText(row.channelId, ROUTING_LIMITS.id); routingText(row.peer, ROUTING_LIMITS.handler); } }
  else if (request.type === 'inc.channel.list') { routingRecord(row, ['type', 'id', 'channels'], ['error']); if (!Array.isArray(row.channels) || row.channels.length > ROUTING_LIMITS.channels) throw new Error('Invalid channels'); for (const channel of row.channels) { const item = routingRecord(channel, ['id', 'peer']); routingText(item.id, ROUTING_LIMITS.id); routingText(item.peer, ROUTING_LIMITS.handler); } }
  else throw new Error('Invalid routing reply');
  return capturedMessage(row);
}
export function createRoutingAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean) {
  return async ({ message, send }: HostOperationContext): Promise<void> => {
    const live = captureRecipient(), request = parseRoutingMessage(message);
    try {
      const response = await native.routing(request);
      if (live() && response !== null) send(response as HostOperationContext['message']);
    } catch (error) {
      if (error instanceof NativeRequestRevoked || !live() || request.id === undefined) return;
      const base = { type: request.type + '.result', id: request.id, error: 'routing unavailable' };
      const response = request.type === 'intent.invoke' ? { ...base, result: { ok: false, handled: false, archetype: request.request!.archetype, action: request.request!.action, error: base.error } }
        : request.type === 'intent.available' ? { ...base, availability: { archetype: request.archetype, available: false, candidates: [], hasDefault: false } }
        : request.type === 'intent.handlers' ? { ...base, handlers: [] } : request.type === 'inc.channel.list' ? { ...base, channels: [] } : base;
      send(response as HostOperationContext['message']);
    }
  };
}
