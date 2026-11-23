import type {RelaySubscribeRequest, RelaySubscriptionMessage} from '../network/relay-subscription-contract.ts';

export interface DiagnosticEntry {
  id: number;
  elapsed: number;
  title: string;
  detail: string;
  hostname?: string;
  networkSettings?: boolean;
}

export function createNappletDiagnostics(now = Date.now) {
  const start = now();
  let sequence = 0;
  const entries: DiagnosticEntry[] = [];
  function add(title: string, detail: string, extra?: Pick<DiagnosticEntry, 'hostname' | 'networkSettings'>) {
    const entry = {id: ++sequence, elapsed: Math.max(0, now() - start), title, detail, ...extra};
    if (entries.length >= 64) entries.shift();
    entries.push(entry);
    return entry;
  }
  add('Publication verified', 'The shell prepared the pinned document for the native host.');
  return {
    snapshot: () => entries.map(entry => ({...entry})),
    ready: () => add('Host ready', 'The native host reported the document ready.'),
    resource() {
      const entry = add('Resource request pending', 'Waiting for the resource broker.');
      return (ok: boolean) => {
        entry.title = ok ? 'Resource request completed' : 'Resource request failed';
        entry.detail = 'Elapsed ' + Math.max(0, now() - start - entry.elapsed) + ' ms.';
      };
    },
    relay(request: RelaySubscribeRequest, original?: unknown) {
      let hostname: string | undefined;
      try { if (request.relay) hostname = new URL(request.relay).hostname; } catch { /* Omit invalid destinations. */ }
      const first = request.filters[0];
      const kind = Array.isArray(first?.kinds) ? first.kinds[0] : undefined;
      const filters = original && typeof original === 'object' && 'filters' in original ? original.filters : undefined;
      const requested = Array.isArray(filters) ? filters[0]?.limit : undefined;
      const scope = [typeof kind === 'number' && 'Kind ' + kind, Number.isSafeInteger(requested) && 'Requested limit ' + requested, typeof first?.limit === 'number' && 'Host filter limit ' + first.limit].filter(Boolean).join(' · ');
      const entry = add('Relay request', scope, {hostname});
      let count = 0;
      return {
        rejected(destination: boolean) {
          entry.title = destination ? 'Relay destination denied' : 'Relay request rejected';
          entry.detail = [scope, destination ? 'This destination is outside the configured relay list.' : 'The shell declined this subscription.'].filter(Boolean).join('\n');
          entry.networkSettings = destination;
        },
        observe(message: RelaySubscriptionMessage) {
          if (message.type === 'relay.event') { count++; entry.detail = scope + '\n' + count + ' events observed'; return; }
          const title = message.type === 'relay.eose' ? 'Stored events complete' : message.reason === 'relay timeout' ? 'Relay timed out' : 'Relay stream closed';
          add(title, [scope, count + ' events observed'].filter(Boolean).join('\n'), {hostname});
        },
      };
    },
  };
}
export type NappletDiagnostics = ReturnType<typeof createNappletDiagnostics>;

export function redactedSummary(entries: readonly DiagnosticEntry[]) {
  return entries.map(row => '+' + row.elapsed + ' ms  ' + row.title + '\n' + row.detail).join('\n');
}
