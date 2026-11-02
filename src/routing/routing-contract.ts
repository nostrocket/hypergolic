export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export const ROUTING_LIMITS = Object.freeze({ payloadBytes: 32768, payloadDepth: 32, payloadNodes: 2048, id: 128, topic: 512, role: 64, convention: 512, handler: 1024, endpoints: 64, topics: 16, channels: 8 });
export class RoutingRequestError extends Error { constructor() { super('Invalid routing request'); this.name = 'RoutingRequestError'; } }
const invalid = (): never => { throw new RoutingRequestError(); };
const owns = (value: object, name: string): boolean => Object.prototype.hasOwnProperty.call(value, name);
export function routingRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), allowed = new Set([...required, ...optional]);
  if (required.some(key => !owns(descriptors, key)) || keys.some(key => typeof key !== 'string' || !allowed.has(key) || !owns(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) return invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key as string]!.value]));
}
export function routingText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || new TextEncoder().encode(value).length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return invalid();
  return value;
}
export function routingPayload(value: unknown): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  function clone(input: unknown, depth: number): JsonValue {
    if (++nodes > ROUTING_LIMITS.payloadNodes || depth > ROUTING_LIMITS.payloadDepth) return invalid();
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number') return Number.isFinite(input) && !Object.is(input, -0) ? input : invalid();
    if (typeof input !== 'object' || ancestors.has(input)) return invalid();
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    let result: JsonValue;
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || input.length > ROUTING_LIMITS.payloadNodes || Reflect.ownKeys(descriptors).length !== input.length + 1) return invalid();
      result = Object.freeze(Array.from({ length: input.length }, (_, index) => {
        const item = descriptors[String(index)];
        return item && owns(item, 'value') && item.enumerable ? clone(item.value, depth + 1) : invalid();
      }));
    } else {
      if (Object.getPrototypeOf(input) !== Object.prototype) return invalid();
      const keys = Reflect.ownKeys(descriptors);
      result = Object.freeze(Object.fromEntries(keys.map(key => {
        if (typeof key !== 'string' || !owns(descriptors[key]!, 'value') || !descriptors[key]!.enumerable) return invalid();
        return [key, clone(descriptors[key]!.value, depth + 1)];
      })));
    }
    ancestors.delete(input);
    return result;
  }
  const captured = clone(value, 0);
  if (new TextEncoder().encode(JSON.stringify(captured)).length > ROUTING_LIMITS.payloadBytes) return invalid();
  return captured;
}
export function routingRole(value: unknown): string {
  const role = routingText(value, ROUTING_LIMITS.role);
  return /^[a-z0-9][a-z0-9-]*$/.test(role) ? role : invalid();
}
export function stableConvention(value: unknown): string {
  const convention = routingText(value, ROUTING_LIMITS.convention);
  return /^napplet:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(convention) ? convention : invalid();
}
export function transposeConvention(uri: string, explicitPayload: boolean): Readonly<{ convention: string; payload?: JsonValue }> {
  if (uri.includes('#')) return invalid();
  const queryAt = uri.indexOf('?');
  if (queryAt < 0) return Object.freeze({ convention: stableConvention(uri) });
  if (explicitPayload || queryAt === uri.length - 1) return invalid();
  const fields: [string, string][] = [], names = new Set<string>();
  for (const pair of uri.slice(queryAt + 1).split('&')) {
    const equals = pair.indexOf('=');
    if (equals < 1) return invalid();
    let name: string, value: string;
    try { name = decodeURIComponent(pair.slice(0, equals)); value = decodeURIComponent(pair.slice(equals + 1)); } catch { return invalid(); }
    if (!name || names.has(name)) return invalid();
    names.add(name); fields.push([name, value]);
  }
  return Object.freeze({ convention: stableConvention(uri.slice(0, queryAt)), payload: routingPayload(Object.fromEntries(fields)) });
}
export type IntentBehavior = Readonly<{ focus?: boolean; newWindow?: boolean; reuse?: boolean }>;
export type IntentRequest = Readonly<{ archetype: string; action: string; convention?: string; payload?: JsonValue; handler?: string; behavior?: IntentBehavior }>;
export function parseIntentRequest(value: unknown): IntentRequest {
  const request = routingRecord(value, ['archetype'], ['action', 'convention', 'payload', 'handler', 'behavior']);
  const result: { archetype: string; action: string; convention?: string; payload?: JsonValue; handler?: string; behavior?: IntentBehavior } = { archetype: routingRole(request.archetype), action: request.action === undefined ? 'open' : routingRole(request.action) };
  const hasPayload = owns(request, 'payload');
  if (hasPayload) result.payload = routingPayload(request.payload);
  if (owns(request, 'convention')) {
    const transposed = transposeConvention(routingText(request.convention, ROUTING_LIMITS.convention), hasPayload);
    result.convention = transposed.convention;
    if (owns(transposed, 'payload')) result.payload = transposed.payload!;
  }
  if (owns(request, 'handler')) result.handler = routingText(request.handler, ROUTING_LIMITS.handler);
  if (owns(request, 'behavior')) {
    const behavior = routingRecord(request.behavior, [], ['focus', 'newWindow', 'reuse']);
    if (Object.values(behavior).some(value => typeof value !== 'boolean')) return invalid();
    result.behavior = Object.freeze(behavior) as IntentBehavior;
  }
  return Object.freeze(result);
}
export type RoutingMessage = Readonly<{ type: string; id?: string; request?: IntentRequest; archetype?: string; topic?: string; target?: string; channelId?: string; payload?: JsonValue }>;
export function parseRoutingMessage(value: unknown): RoutingMessage {
  if (!value || typeof value !== 'object') return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !owns(descriptor, 'value') || typeof descriptor.value !== 'string') return invalid();
  const type = descriptor.value;
  const schemas: Record<string, readonly [readonly string[], readonly string[]]> = {
    'intent.invoke': [['id', 'request'], []], 'intent.available': [['id', 'archetype'], []], 'intent.handlers': [['id'], []],
    'inc.subscribe': [['id', 'topic'], []], 'inc.unsubscribe': [['topic'], []], 'inc.emit': [['topic'], ['payload']],
    'inc.channel.open': [['id', 'target'], []], 'inc.channel.list': [['id'], []], 'inc.channel.emit': [['channelId'], ['payload']],
    'inc.channel.broadcast': [[], ['payload']], 'inc.channel.close': [['channelId'], []],
  };
  const schema = Object.prototype.hasOwnProperty.call(schemas, type) ? schemas[type] : undefined;
  if (!schema) return invalid();
  const message = routingRecord(value, ['type', ...schema[0]], schema[1]);
  const result: { type: string; id?: string; request?: IntentRequest; archetype?: string; topic?: string; target?: string; channelId?: string; payload?: JsonValue } = { type };
  if (owns(message, 'id')) result.id = routingText(message.id, ROUTING_LIMITS.id);
  if (owns(message, 'request')) result.request = parseIntentRequest(message.request);
  if (owns(message, 'archetype')) result.archetype = routingRole(message.archetype);
  if (owns(message, 'payload')) result.payload = routingPayload(message.payload);
  if (owns(message, 'topic')) {
    const topic = routingText(message.topic, ROUTING_LIMITS.topic);
    if (type === 'inc.emit' && topic.startsWith('napplet:')) {
      const transposed = transposeConvention(topic, owns(message, 'payload'));
      result.topic = transposed.convention;
      if (owns(transposed, 'payload')) result.payload = transposed.payload!;
    } else result.topic = topic;
  }
  if (owns(message, 'target')) result.target = routingText(message.target, ROUTING_LIMITS.handler);
  if (owns(message, 'channelId')) result.channelId = routingText(message.channelId, ROUTING_LIMITS.id);
  return Object.freeze(result);
}
