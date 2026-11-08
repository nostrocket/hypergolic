import {COMMON_OPERATIONS,parseCommonRequest,commonFailure} from '../../src/common/common-contract';
import {parseOutboxSubscribe,parseOutboxClose} from '../../src/outbox/subscription-contract';
import {parseConfigMessage} from '../../src/presentation/config-contract';
import {captureNotifyRejection, parseNotifyMessage} from '../../src/presentation/notify-contract';
import { parseRoutingMessage } from '../../src/routing/routing-contract';
import { linkRequestId } from '../../src/links/link-contract';
import { parseUploadRequest, UploadError, UPLOAD_LIMITS } from '../../src/uploads/upload-contract';
import { text } from '../../src/storage/codec';
import { parseRelaySubscribe, parseRelayClose } from '../../src/network/relay-subscription-contract';

const privilegedRequests = new Set([...COMMON_OPERATIONS,'identity.getPublicKey', 'identity.getRelays', 'identity.getProfile',
  'identity.getFollows', 'identity.getMutes', 'identity.getBlocked', 'identity.getList',
  'identity.getZaps', 'identity.getBadges', 'storage.get', 'storage.set', 'storage.remove', 'storage.keys', 'relay.query', 'outbox.query', 'outbox.getEvent', 'outbox.resolveRelays', 'outbox.publish', 'resource.info', 'resource.bytes', 'resource.bytesMany', 'resource.cancel']);
export function validEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if (typeof message.type === 'string' && message.type.startsWith('common.')) {try {parseCommonRequest(value); return true;} catch {return false;}}
  if (typeof message.type === 'string' && message.type.startsWith('config.')) {try {parseConfigMessage(value); return true;} catch {return false;}}
  if (typeof message.type === 'string' && message.type.startsWith('notify.')) {try {parseNotifyMessage(value); return true;} catch {return false;}}
  if (typeof message.type === 'string' && (message.type.startsWith('intent.') || message.type.startsWith('inc.'))) { try { parseRoutingMessage(value); return true; } catch { return false; } }
  if (message.type === 'link.open') return linkRequestId(value) !== null;
  if (typeof message.type === 'string' && message.type.startsWith('upload.')) {
    try { parseUploadRequest(value); return true; } catch { return false; }
  }
  if(message.type==='outbox.subscribe'||message.type==='outbox.close'){try{if(message.type==='outbox.subscribe')parseOutboxSubscribe(value);else parseOutboxClose(value);return true;}catch{return false;}}
  if(message.type==='relay.subscribe'||message.type==='relay.close') {
    try {if(message.type==='relay.subscribe')parseRelaySubscribe(value);else parseRelayClose(value);return true;}catch{return false;}
  }
  if (message.type === 'shell.ready') return keys.length === 1;
  if (typeof message.type === 'string' && privilegedRequests.has(message.type)) {
    try { return typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
      && new TextEncoder().encode(JSON.stringify(value)).length <= 2 * 1024 * 1024; }
    catch { return false; }
  }
  if (message.type === 'relay.publish') {
    if (keys.length !== 3 || !keys.includes('id') || !keys.includes('event') ||
        typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 128) return false;
    const event = message.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const eventKeys = Object.keys(event);
    if (eventKeys.length !== 4 || !['kind', 'content', 'tags', 'created_at'].every(key => eventKeys.includes(key))) return false;
    const template = event as Record<string, unknown>;
    if (typeof template.kind !== 'number' || !Number.isSafeInteger(template.kind) || template.kind < 0 || template.kind > 65535 ||
        typeof template.created_at !== 'number' || !Number.isSafeInteger(template.created_at) || template.created_at < 0 ||
        typeof template.content !== 'string' || !Array.isArray(template.tags)) return false;
    try { return new TextEncoder().encode(JSON.stringify(value)).length <= 2 * 1024 * 1024; }
    catch { return false; }
  }
  return message.type === 'theme.get' && keys.length === 2
    && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128
    && keys.every(key => key === 'type' || key === 'id');
}

export function rejectEnvelope(event: MessageEvent, source: Window, domains: readonly string[]): void {
      if (domains.includes('common')) {
        const reply = commonFailure(event.data);
        if (reply) {source.postMessage(reply,'*');return;}
      }
      if (domains.includes('relay') && event.data?.type === 'relay.publish') {
        const id = event.data.id;
        if (typeof id === 'string' && id.length > 0 && id.length <= 128 &&
          new TextEncoder().encode(id).length <= 128) {
          source.postMessage({type: 'relay.publish.result', id, ok: false, error: 'Invalid event template.'}, '*');
        }
        return;
      }
      const type = event.data?.type;
      if (domains.includes('upload') && (type === 'upload.info' || type === 'upload.upload' || type === 'upload.status')) {
        let id: string;
        try { id = text(event.data.id, UPLOAD_LIMITS.idBytes); } catch { return; }
        try { parseUploadRequest(event.data); } catch (error) {
          source.postMessage({type: type + '.result', id, error: error instanceof UploadError ? error.code : 'invalid request'}, '*');
        }
        return;
      }
      if (domains.includes('notify')) {
        const rejection = captureNotifyRejection(event.data);
        if (rejection !== null) source.postMessage({...rejection}, '*');
      }
      // A denied subscribe acquires no Kehto/native authority. Reply only to the captured
      // registered frame with an independently validated caller correlation identifier.
      if ((event.data?.type === 'relay.subscribe' && domains.includes('relay')) ||
          (event.data?.type === 'outbox.subscribe' && domains.includes('outbox'))) {
        try {
          const outbox=event.data.type==='outbox.subscribe';
          const denied = outbox?parseOutboxClose({type:'outbox.close',id:event.data.id,subId:event.data.subId}):parseRelayClose({type:'relay.close',id:event.data.id,subId:event.data.subId});
          source.postMessage({type:outbox?'outbox.closed':'relay.closed',subId:denied.subId,reason:'invalid or unsupported relay subscription'}, '*');
        } catch { /* An invalid correlation identifier has no SDK recipient. */ }
      }
}
