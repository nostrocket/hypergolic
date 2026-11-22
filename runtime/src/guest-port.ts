import type {ShellBridge} from '@kehto/shell';
import {quotaReply, validEnvelope} from './guest-envelope';

/** One guest-created channel per verified frame generation. */
export function createGuestPort(frame: HTMLIFrameElement, source: Window, bridge: ShellBridge,
  domains: readonly string[], ready: () => void, fail: () => void) {
  let port: MessagePort | undefined;
  let closed = false;
  let operations = 0;
  let started = performance.now();
  const current = () => !closed && frame.isConnected && frame.contentWindow === source;
  return {
    receive(event: MessageEvent) {
      if (!current() || !event.isTrusted || event.source !== source || event.origin !== 'null') return;
      if (port || event.data?.type !== 'napplet.hello' || Object.keys(event.data).length !== 1 || event.ports.length !== 1) {
        for (const unused of event.ports) unused.close();
        return;
      }
      const connection = event.ports[0]!;
      port = connection;
      const send = (message: unknown) => { if (current()) connection.postMessage(message); };
      const dispatch = bridge.bindPort(source, event.origin, send);
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
        if (++operations > 64 || !validEnvelope(value)) {
          const reply = quotaReply(value, domains, operations > 64 ? 'quota-exceeded' : 'invalid-request');
          if (reply) send(reply);
          return;
        }
        dispatch(value);
      };
      ready();
    },
    close() {
      closed = true;
      if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
    },
  };
}
