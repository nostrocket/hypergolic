const SNAPSHOT_PREFIX = ' 5129:';
const SNAPSHOT_ROUTING_PREFIX = ' snapshot:';
const INVALID_TITLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u206f\ud800-\udfff]/gu;

export type SnapshotIdentity = Readonly<{kind:5129;eventId:string;title:string}>;

export function isPublishedEventId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/** Named identifiers cannot contain leading whitespace. Never trim this private owner key. */
export const snapshotAppKey = (eventId: string): string => SNAPSHOT_PREFIX + eventId;

export function snapshotEventId(appId: unknown): string | null {
  if (typeof appId !== 'string' || !appId.startsWith(SNAPSHOT_PREFIX)) return null;
  const eventId = appId.slice(SNAPSHOT_PREFIX.length);
  return isPublishedEventId(eventId) ? eventId : null;
}

export function matchesPublishedAppKey(appId: string, eventId: string): boolean {
  return !appId.startsWith(SNAPSHOT_PREFIX) || snapshotEventId(appId) === eventId;
}

export function boundedPublishedTitle(input: string): string {
  const clean = input.replace(/\s/g, ' ').replace(INVALID_TITLE, '').replace(/ +/g, ' ').trim();
  const encoder = new TextEncoder();
  let result = '', size = 0;
  for (const character of clean) {
    size += encoder.encode(character).byteLength;
    if (size > 128) break;
    result += character;
  }
  return result.trimEnd();
}

/** Capture the optional native snapshot fields only with the exact private owner key. */
export function captureSnapshotIdentity(input: unknown, appId: string): SnapshotIdentity | undefined {
  const eventId = snapshotEventId(appId);
  if (input === undefined && !appId.startsWith(SNAPSHOT_PREFIX)) return undefined;
  if (!eventId || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype) throw new Error('Invalid published snapshot');
  const fields = Object.getOwnPropertyDescriptors(input);
  const kind = fields.kind?.value, id = fields.eventId?.value, title = fields.title?.value;
  if (Reflect.ownKeys(fields).length !== 3 || kind !== 5129 || id !== eventId ||
      typeof title !== 'string' || !title || title.length > 128 || boundedPublishedTitle(title) !== title) {
    throw new Error('Invalid published snapshot');
  }
  return Object.freeze({kind:5129,eventId,title});
}

/** Public labels use the opaque catalog identity and never expose the private key. */
export function publishedAppLabel(appId: string): string {
  const eventId = snapshotEventId(appId);
  return eventId ? `5129:${eventId}` : appId;
}

/** Legacy routing accepts raw named d values. The opaque snapshot alias stays disjoint. */
export function routingAppLabel(appId: string): string {
  const eventId = snapshotEventId(appId);
  return eventId ? SNAPSHOT_ROUTING_PREFIX + eventId : appId;
}

export function isSnapshotRoutingId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SNAPSHOT_ROUTING_PREFIX) &&
    isPublishedEventId(value.slice(SNAPSHOT_ROUTING_PREFIX.length));
}
