import { fail, LIMITS } from './ports.ts';
import type { NappletDescriptor, WorkspaceSnapshot } from '../shell/workspace.ts';

/** Reject unpaired UTF-16 surrogates so SQLite's UTF-8 encoding cannot change an accepted string. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) bytes++;
    else if (c <= 0x7ff) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_INPUT');
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) fail('INVALID_INPUT');
    else bytes += 3;
  }
  return bytes;
}
export function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max || utf8Bytes(value) > max) return fail('INVALID_INPUT');
  return value;
}
export function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return fail('INVALID_INPUT');
  return value;
}
export const version = publicKey;
export function identifier(value: unknown): string {
  const result = text(value, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) return fail('INVALID_INPUT');
  return result;
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return fail('INVALID_INPUT');
  return value;
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('INVALID_INPUT');
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return fail('INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))) return fail('INVALID_INPUT');
  return value as Record<string, unknown>;
}
function descriptor(value: unknown): NappletDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('INVALID_INPUT');
  const sourceField = Object.getOwnPropertyDescriptor(value, 'source');
  const source = sourceField && Object.hasOwn(sourceField, 'value') ? sourceField.value : undefined;
  const item = object(value, source === 'published'
    ? ['id', 'title', 'publisher', 'appId', 'version', 'source', 'eventId']
    : ['id', 'title', 'publisher', 'appId', 'version', 'source']);
  // Preserve the current workspace model, including the explicitly unsigned bundled fixture.
  const id = identifier(item.id);
  function field(value: unknown, characters: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > characters) return fail('INVALID_INPUT');
    utf8Bytes(value);
    return value;
  }
  const title = field(item.title, 128), publisher = field(item.publisher, 128);
  const appId = field(item.appId, 256), selectedVersion = field(item.version, 128);
  if (item.source !== 'bundled' && item.source !== 'published') return fail('INVALID_INPUT');
  if (item.source === 'published' && (typeof item.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(item.eventId))) return fail('INVALID_INPUT');
  return Object.freeze({ id, title, publisher, appId, version: selectedVersion, source: item.source,
    ...(item.source === 'published' ? { eventId: item.eventId as string } : {}) });
}
export function snapshot(value: unknown): WorkspaceSnapshot {
  const item = object(value, ['schema', 'sessions', 'lastActiveId']);
  if (item.schema !== 1 || !Array.isArray(item.sessions) || item.sessions.length > 64 || Object.getPrototypeOf(item.sessions) !== Array.prototype || Reflect.ownKeys(item.sessions).length !== item.sessions.length + 1) return fail('INVALID_INPUT');
  const sessions: NappletDescriptor[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < item.sessions.length; i++) {
    const field = Object.getOwnPropertyDescriptor(item.sessions, String(i));
    if (!field || !Object.hasOwn(field, 'value')) return fail('INVALID_INPUT');
    const next = descriptor(field.value);
    if (ids.has(next.id)) return fail('INVALID_INPUT');
    ids.add(next.id); sessions.push(next);
  }
  if (item.lastActiveId !== null && (typeof item.lastActiveId !== 'string' || !ids.has(item.lastActiveId))) return fail('INVALID_INPUT');
  return Object.freeze({ schema: 1, sessions: Object.freeze(sessions), lastActiveId: item.lastActiveId });
}
export function encodeSnapshot(value: unknown): string {
  const payload = JSON.stringify(snapshot(value));
  if (utf8Bytes(payload) > LIMITS.workspaceBytes) return fail('INVALID_INPUT');
  return payload;
}
export function decodeSnapshot(payload: unknown): WorkspaceSnapshot {
  try {
    if (typeof payload !== 'string' || utf8Bytes(payload) > LIMITS.workspaceBytes) return fail('CORRUPT_STORAGE');
    return snapshot(JSON.parse(payload));
  } catch { return fail('CORRUPT_STORAGE'); }
}
