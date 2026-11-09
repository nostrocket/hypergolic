import type { NappletMessage, ServiceRuntimeContext } from '@kehto/runtime';

const INTENT_DELIVERY_PORT = 'hypergolic.intent.delivery-port';
const MAX_PENDING = 4;

function createIntentDeliveryPort() {
  let port: MessagePort | null = null;
  let sequence = 0;
  const pending = new Map<number, () => void>();
  return {
    connected: () => port !== null,
    connect(event: MessageEvent) {
      const [candidate] = event.ports;
      if (port || !candidate || event.ports.length !== 1 || Object.keys(event.data).length !== 1) {
        for (const received of event.ports) received.close();
        return;
      }
      port = candidate;
      port.onmessage = event => {
        if (!event.isTrusted || !Number.isSafeInteger(event.data)) return;
        const acknowledge = pending.get(event.data);
        if (!acknowledge) return;
        pending.delete(event.data);
        acknowledge();
      };
    },
    send(message: NappletMessage, acknowledge: () => void): boolean {
      if (!port || pending.size >= MAX_PENDING || sequence >= Number.MAX_SAFE_INTEGER) return false;
      const receipt = ++sequence;
      pending.set(receipt, acknowledge);
      try { port.postMessage({receipt, message}); return true; }
      catch { pending.delete(receipt); return false; }
    },
    close() {
      port?.close();
      port = null;
      pending.clear();
    },
  };
}

export function createGuestRouting(domains: readonly string[], windowId: string, live: () => boolean,
  register: () => void, fail: () => void) {
  const intent = domains.includes('intent') ? createIntentDeliveryPort() : null;
  const supported = intent !== null || domains.includes('inc');
  let context: ServiceRuntimeContext | null = null;
  let registered = false;
  const ready = () => {
    if (!supported || registered || !live() || (intent && !intent.connected())) return;
    registered = true;
    register();
  };
  return {
    setContext(value: ServiceRuntimeContext | null) { context = value; },
    connect(event: MessageEvent): boolean {
      if (event.data?.type !== INTENT_DELIVERY_PORT) return false;
      if (intent) { intent.connect(event); ready(); }
      else for (const port of event.ports) port.close();
      return true;
    },
    deliver(message: NappletMessage, acknowledge: () => void) {
      if (!live() || !domains.includes(message.type.split('.')[0]!)) return;
      if (message.type !== 'intent.deliver') { context?.sendToEligibleNapplet(windowId, message); return; }
      if (!context?.sendToEligibleNapplet(windowId, message, eligible => intent?.send(eligible, acknowledge) ?? false)) fail();
    },
    ready,
    close() { intent?.close(); },
  };
}
