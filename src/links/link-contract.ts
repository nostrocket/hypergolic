export const LINK_LIMITS = Object.freeze({urlBytes: 4096, labelBytes: 256, idBytes: 128, reviewMs: 25_000});
export type LinkRequest = Readonly<{type: 'link.open'; id: string; url: string; options?: Readonly<{label?: string}>}>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string') || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) throw Error('Invalid link request');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || new TextEncoder().encode(value).length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid link request');
  return value;
}
export function linkRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string') || Object.values(fields).some(field => !('value' in field))) return null;
  const id = fields.id?.value;
  if (fields.type?.value !== 'link.open' || typeof id !== 'string' || !id.length || new TextEncoder().encode(id).length > LINK_LIMITS.idBytes || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}
export function parseLinkRequest(value: unknown): LinkRequest {
  const v = object(value);
  if (v.type !== 'link.open' || Object.keys(v).some(k => !['type', 'id', 'url', 'options'].includes(k))) throw Error('Invalid link request');
  const id = text(v.id, LINK_LIMITS.idBytes), url = text(v.url, LINK_LIMITS.urlBytes);
  if (!Object.hasOwn(v, 'options')) return Object.freeze({type: 'link.open', id, url});
  const options = object(v.options);
  if (Object.keys(options).some(k => k !== 'label')) throw Error('Invalid link options');
  const label = Object.hasOwn(options, 'label') ? text(options.label, LINK_LIMITS.labelBytes, true) : undefined;
  return Object.freeze({type: 'link.open', id, url, options: Object.freeze(label === undefined ? {} : {label})});
}
export function linkDenied(id: string, error: string = 'blocked-by-policy') {
  return Object.freeze({type: 'link.open.result' as const, id, status: 'denied' as const, error});
}
export function captureLinkResult(value: unknown, id: string) {
  const v = object(value);
  if (v.type !== 'link.open.result' || v.id !== id || !['opened', 'denied'].includes(v.status as string) ||
    Object.keys(v).some(k => !['type', 'id', 'status', 'error'].includes(k)) ||
    (Object.hasOwn(v, 'error') && (v.status !== 'denied' || typeof v.error !== 'string' || v.error.length > 256))) throw Error('Invalid link result');
  return Object.freeze({...v}) as Readonly<{type: 'link.open.result'; id: string; status: 'opened' | 'denied'; error?: string}>;
}
