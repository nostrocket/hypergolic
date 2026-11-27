import {isKeysMessage, type createKeysSession} from './keys-adapter';
import type {ShellBridge} from '@kehto/shell';
import {quotaReply, validEnvelope, rejectEnvelope} from './guest-envelope';
import {observePortLifetime} from './port-lifetime';

export type GuestBindingTransport = {send(value: object): void; listen(callback: (value: unknown) => void): () => void};

/** One guest-created channel per verified frame generation. */
export function createGuestPort(frame: HTMLIFrameElement, source: Window, bridge: ShellBridge,
  domains: readonly string[], account: () => string | undefined, consumeIntent: (receipt: unknown) => void,
  routes: {files?: ((value:Record<string,unknown>)=>void) | undefined; enforcePrivateChannel: boolean; checkpoint: ((value: Record<string, unknown>) => void) | undefined; keys: ReturnType<typeof createKeysSession> | null; media(value: unknown): boolean;
    cvm: ((value: unknown) => void) | null; mesh: ((value: unknown) => boolean) | undefined}, ready: () => void, fail: () => void) {
  let port: MessagePort | undefined;
  let stopObserving: (() => void) | undefined;
  let closed = false;
  let operations = 0;
  let started = performance.now();
  const current = () => !closed && frame.isConnected && frame.contentWindow === source;
  const send = (message: unknown) => { if (current()) port?.postMessage(message); };
  return {
    send,
    receive(event: MessageEvent) {
      if (!current() || !event.isTrusted || event.source !== source) return;
      if (port || event.origin !== 'null' || event.data?.type !== 'napplet.hello' || Object.keys(event.data).length !== 1 || event.ports.length !== 1) {
        for (const unused of event.ports) unused.close();
        if (port && routes.enforcePrivateChannel) fail();
        return;
      }
      const connection = event.ports[0]!;
      port = connection;
      const dispatch = bridge.bindPort(source, event.origin, send);
      stopObserving = observePortLifetime(connection, fail);
      connection.onmessageerror = fail;
      connection.onmessage = message => {
        if (!current() || !message.isTrusted || message.origin !== '') return;
        if (message.ports.length) {
          for (const unused of message.ports) unused.close();
          return;
        }
        const now = performance.now();
        if (now - started > 1000) { started = now; operations = 0; }
        const value = message.data;
        if (value?.type === 'hypergolic.port.pong') return;
        if (value?.type === 'hypergolic.intent.consumed') {
          if (Object.keys(value).length === 2) consumeIntent(value.receipt);
          return;
        }
        const cleanup = value?.type === 'relay.close' || value?.type === 'outbox.close' || value?.type === 'resource.cancel';
        if (++operations > 64 && !cleanup) {
          const reply = quotaReply(value, domains, 'quota-exceeded', account());
          if (reply) send(reply);
          return;
        }
        if (value?.type === 'hypergolic.checkpoint.result' || value?.type === 'hypergolic.restoreCheckpoint.result') {
          routes.checkpoint?.(value);
          return;
        }
        if (typeof value?.type === 'string' && value.type.startsWith('fs.')) { routes.files?.(value); return; }
        if (isKeysMessage(value)) {
          routes.keys?.receive(value);
          return;
        }
        if (routes.mesh?.(value) || routes.media(value)) return;
        if (typeof value?.type === 'string' && value.type.startsWith('cvm.')) {
          routes.cvm?.(value);
          return;
        }
        if (!validEnvelope(value)) {
          rejectEnvelope(message, {postMessage:send}, domains, account());
          return;
        }
        dispatch(value);
      };
      ready();
    },
    close() {
      closed = true;
      if (port) {
        stopObserving?.();
        port.onmessage = null;
        port.onmessageerror = null;
        port.close();
      }
    },
  };
}
