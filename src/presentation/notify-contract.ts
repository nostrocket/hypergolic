import { routingPayload, routingRecord, routingText } from '../routing/routing-contract.ts';
export const NOTIFY_LIMITS = Object.freeze({ cards: 32, perSource: 8, channels: 16, badge: 999, sendsPerMinute: 12, permissionPerMinute: 4, textBytes: 4096 });
export type NotifyAction = Readonly<{id: string; label: string}>;
export type NotifyPriority = 'low' | 'normal' | 'high' | 'urgent';
export type NotifyMessage = Readonly<{type: 'notify.send'; id: string; title: string; body?: string; icon?: string; actions?: readonly NotifyAction[]; channel?: string; priority?: NotifyPriority}>
  | Readonly<{type: 'notify.permission.request'; id: string; channel?: string}>
  | Readonly<{type: 'notify.dismiss'; notificationId: string}>
  | Readonly<{type: 'notify.badge'; count: number}>
  | Readonly<{type: 'notify.channel.register'; channelId: string; label: string; description?: string; defaultPriority?: NotifyPriority}>;
const has = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);
export function notifyPriority(value: unknown): NotifyPriority {
  if (value !== 'low' && value !== 'normal' && value !== 'high' && value !== 'urgent') throw new Error('Invalid priority'); return value;
}
export function parseNotifyMessage(value: unknown): NotifyMessage {
  const input = routingRecord(routingPayload(value), ['type'], ['id', 'title', 'body', 'icon', 'actions', 'channel', 'priority', 'notificationId', 'count', 'channelId', 'label', 'description', 'defaultPriority']);
  if (input.type === 'notify.send') {
    const row = routingRecord(input, ['type', 'id', 'title'], ['body', 'icon', 'actions', 'channel', 'priority']);
    routingText(row.id, 128); routingText(row.title, 256);
    for (const key of ['body', 'icon', 'channel']) if (has(row, key)) routingText(row[key], key === 'body' ? NOTIFY_LIMITS.textBytes : key === 'channel' ? 128 : 1024);
    if (has(row, 'priority')) notifyPriority(row.priority);
    if (has(row, 'actions')) {
      if (!Array.isArray(row.actions) || row.actions.length > 3) throw new Error('Invalid actions');
      const ids = new Set<string>();
      for (const item of row.actions) { const action = routingRecord(item, ['id', 'label']); const id = routingText(action.id, 128); routingText(action.label, 80); if (ids.has(id)) throw new Error('Duplicate action'); ids.add(id); }
    }
    return Object.freeze(row) as NotifyMessage;
  }
  if (input.type === 'notify.permission.request') { const row = routingRecord(input, ['type', 'id'], ['channel']); routingText(row.id, 128); if (has(row, 'channel')) routingText(row.channel, 128); return Object.freeze(row) as NotifyMessage; }
  if (input.type === 'notify.dismiss') { const row = routingRecord(input, ['type', 'notificationId']); routingText(row.notificationId, 128); return Object.freeze(row) as NotifyMessage; }
  if (input.type === 'notify.badge') { const row = routingRecord(input, ['type', 'count']); if (!Number.isSafeInteger(row.count) || (row.count as number) < 0 || (row.count as number) > NOTIFY_LIMITS.badge) throw new Error('Invalid badge'); return Object.freeze(row) as NotifyMessage; }
  if (input.type === 'notify.channel.register') {
    const row = routingRecord(input, ['type', 'channelId', 'label'], ['description', 'defaultPriority']); routingText(row.channelId, 128); routingText(row.label, 128);
    if (has(row, 'description')) routingText(row.description, 1024); if (has(row, 'defaultPriority')) notifyPriority(row.defaultPriority);
    return Object.freeze(row) as NotifyMessage;
  }
  throw new Error('Unknown notification operation');
}
/** A denial needs a bounded, authority-free correlation header, never a valid payload. */
export function captureNotifyRejection(value: unknown): Readonly<Record<string, unknown> & {type: string}> | null {
  try {
    const row = routingRecord(routingPayload(value), ['type', 'id'], ['title', 'body', 'icon', 'actions', 'channel', 'priority']);
    const id = routingText(row.id, 128);
    if (row.type === 'notify.send') return Object.freeze({type: 'notify.send.result', id, error: 'invalid notification'});
    if (row.type === 'notify.permission.request') {
      routingRecord(row, ['type', 'id'], ['channel']);
      return Object.freeze({type: 'notify.permission.result', id, granted: false});
    }
  } catch { /* Unknown authority, accessors and unbounded headers have no reply path. */ }
  return null;
}
export const NOTIFY_CONTROLS = Object.freeze(['toasts', 'badges', 'actions', 'channels']);
export function captureNotifyPush(value: unknown): Readonly<Record<string, unknown> & {type: string}> {
  const row = routingRecord(routingPayload(value), ['type'], ['notificationId', 'actionId', 'reason', 'controls']);
  if (row.type === 'notify.controls') {
    routingRecord(row, ['type', 'controls']); if (!Array.isArray(row.controls) || row.controls.length > 4 || row.controls.some(control => !NOTIFY_CONTROLS.includes(control)) || new Set(row.controls).size !== row.controls.length) throw new Error('Invalid controls');
  } else {
    if (!['notify.action', 'notify.clicked', 'notify.dismissed'].includes(row.type as string)) throw new Error('Invalid notification event');
    routingRecord(row, row.type === 'notify.action' ? ['type', 'notificationId', 'actionId'] : ['type', 'notificationId'], row.type === 'notify.dismissed' ? ['reason'] : []);
    routingText(row.notificationId, 128); if (has(row, 'actionId')) routingText(row.actionId, 128); if (has(row, 'reason') && !['user', 'timeout', 'replaced'].includes(row.reason as string)) throw new Error('Invalid dismissal');
  }
  return Object.freeze(row) as Readonly<Record<string, unknown> & {type: string}>;
}
export function captureNotifyReply(value: unknown, request: NotifyMessage): Readonly<Record<string, unknown> & {type: string}> | null {
  if (!('id' in request)) { if (value !== null) throw new Error('Unexpected notification receipt'); return null; }
  const permission = request.type === 'notify.permission.request';
  const row = routingRecord(routingPayload(value), ['type', 'id'], permission ? ['granted'] : ['notificationId', 'error']);
  if (row.id !== request.id || row.type !== (permission ? 'notify.permission.result' : 'notify.send.result')) throw new Error('Notification response mismatch');
  if (permission) { if (typeof row.granted !== 'boolean') throw new Error('Invalid permission result'); }
  else if (has(row, 'error')) { routingText(row.error, 256); if (has(row, 'notificationId')) throw new Error('Invalid notification result'); }
  else routingText(row.notificationId, 128);
  return Object.freeze(row) as Readonly<Record<string, unknown> & {type: string}>;
}
