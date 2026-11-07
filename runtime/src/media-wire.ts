const actions = ['play', 'pause', 'stop', 'seek', 'volume'] as const;
const reasons = ['user', 'ended', 'error', 'preempted', 'focus-lost', 'destroyed', 'backend-exited', 'policy'] as const;
export type MediaAction = typeof actions[number];
type Reason = typeof reasons[number];
export type MediaState = Readonly<{status: 'paused' | 'buffering' | 'playing' | 'stopped'; position?: number; duration?: number; volume?: number; reason?: Reason}>;
export type MediaEvent = Readonly<{type:'media.session.create.result'; id:string; sessionId?:string; owner?:'shell'; error?:string}>
  | (Readonly<{type:'media.state'; sessionId:string}> & MediaState)
  | Readonly<{type:'media.capabilities'; sessionId:string; actions:readonly MediaAction[]}>
  | Readonly<{type:'media.session.ended'; sessionId:string; reason:Reason}>;
export type MediaRequest = Readonly<{type:'media.session.create'; id:string; url:string}>
  | Readonly<{type:'media.session.destroy'; sessionId:string}>
  | Readonly<{type:'media.command'; sessionId:string; action:MediaAction; value?:number}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function keys(value: Record<string, unknown>, permitted: readonly string[]): boolean {
  return Object.keys(value).every(key => permitted.includes(key));
}
export function mediaRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[!-~]{1,128}$/.test(value) ? value : null;
}
function sessionId(value: unknown): value is string {
  return typeof value === 'string' && /^media-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function projectMediaRequest(value: unknown): MediaRequest | null {
  const message = record(value);
  if (!message) return null;
  if (message.type === 'media.session.create') {
    const id = mediaRequestId(message.id), source = record(message.source), metadata = record(message.metadata);
    if (!id || message.owner !== 'shell' || !source || !keys(source, ['url', 'mimeType']) ||
        (source.mimeType !== undefined && source.mimeType !== 'video/mp4') || typeof source.url !== 'string' ||
        source.url.length > 8192 || new TextEncoder().encode(source.url).length > 8192 || /[\u0000-\u001f\u007f]/.test(source.url) ||
        message.live !== undefined && message.live !== false ||
        message.metadata !== undefined && (!metadata || metadata.mediaType !== undefined && metadata.mediaType !== 'video') ||
        message.autoplay !== undefined && typeof message.autoplay !== 'boolean' ||
        message.queue !== undefined && (!Array.isArray(message.queue) || message.queue.length > 96) ||
        !keys(message, ['type', 'id', 'owner', 'source', 'sessionId', 'metadata', 'context', 'capabilities', 'autoplay', 'live', 'queue', 'queueIndex', 'aspectRatio', 'loop'])) return null;
    return {type:message.type, id, url:source.url};
  }
  if (!sessionId(message.sessionId)) return null;
  if (message.type === 'media.session.destroy' && keys(message, ['type', 'sessionId'])) return {type:message.type, sessionId:message.sessionId};
  if (message.type !== 'media.command' || !keys(message, ['type', 'sessionId', 'action', 'value']) || !actions.includes(message.action as MediaAction)) return null;
  const action = message.action as MediaAction;
  if (action === 'seek' || action === 'volume') {
    if (typeof message.value !== 'number' || !Number.isFinite(message.value) || message.value < 0 || message.value > (action === 'seek' ? 3600 : 1)) return null;
    return {type:message.type, sessionId:message.sessionId, action, value:message.value};
  }
  return message.value === undefined ? {type:message.type, sessionId:message.sessionId, action} : null;
}
export function mediaEvent(value: unknown): MediaEvent | null {
  const row = record(value);
  if (!row) return null;
  if (row.type === 'media.session.create.result') {
    const id = mediaRequestId(row.id);
    if (!id) return null;
    if (keys(row, ['type','id','error']) && typeof row.error === 'string' && row.error.length <= 100) return {type:row.type,id,error:row.error};
    if (keys(row, ['type','id','sessionId','owner']) && sessionId(row.sessionId) && row.owner === 'shell') return {type:row.type,id,sessionId:row.sessionId,owner:row.owner};
    return null;
  }
  if (!sessionId(row.sessionId)) return null;
  if (row.type === 'media.session.ended' && keys(row, ['type','sessionId','reason']) && reasons.includes(row.reason as Reason)) {
    return {type:row.type,sessionId:row.sessionId,reason:row.reason as Reason};
  }
  if (row.type === 'media.capabilities' && keys(row, ['type','sessionId','actions']) && Array.isArray(row.actions) &&
      row.actions.length <= actions.length && new Set(row.actions).size === row.actions.length && row.actions.every(action => actions.includes(action))) {
    return {type:row.type,sessionId:row.sessionId,actions:row.actions};
  }
  if (row.type !== 'media.state' || !keys(row, ['type','sessionId','status','reason','position','duration','volume']) ||
      !['paused','buffering','playing','stopped'].includes(row.status as string) || row.reason !== undefined && !reasons.includes(row.reason as Reason)) return null;
  for (const field of ['position','duration','volume']) {
    const n = row[field];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > (field === 'volume' ? 1 : 3600))) return null;
  }
  return row as MediaEvent;
}
