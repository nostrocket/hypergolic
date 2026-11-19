import { recommendationsPrelude } from './discovery-recommendations';
import { catalogPagePrelude } from './discovery-catalog';
import { DISCOVERY_LEASE_MS, DISCOVERY_OPEN, DISCOVERY_OUTCOMES, DISCOVERY_FAILURE_STATUS, discoveryOpenOutcome, parseDiscoveryOpen } from '../../src/napplets/discovery-open-contract';
import { NativeRequestRevoked, type createNativeClient } from './native-client';

const RESULT = DISCOVERY_OPEN + '.result';

/** Install only in the verified catalog HTML. The top document still authenticates every request. */
export function injectDiscoveryOpen(html: string, token: string, catalogEnabled = false, bundled = false): string {
  const state = JSON.stringify({ type: DISCOVERY_OPEN, outcomes: DISCOVERY_OUTCOMES, failureStatus: DISCOVERY_FAILURE_STATUS, token }).replace(/</g, '\\u003c');
  const script = `<script>(() => {
    const { type, outcomes, failureStatus, token } = ${state};
    let pending;
    window.addEventListener('message', event => {
      const data = event.data;
      if (!pending || !event.isTrusted || event.source !== parent ||
          data?.type !== type + '.result' || data.id !== pending.id ||
          Object.keys(data).length !== 3 || !outcomes.includes(data.status)) return;
      const reply = pending;
      pending = undefined;
      clearTimeout(reply.timer);
      const reason = Object.prototype.hasOwnProperty.call(failureStatus, data.status) ? data.status : undefined;
      reply.resolve(Object.freeze(reason ? { status: failureStatus[reason], reason } : { status: data.status }));
    });
    const open = (address, expectedEventId, action) => {
      if (pending) return Promise.resolve({ status: 'busy' });
      if (typeof address !== 'string' || address.length > 512 ||
          typeof expectedEventId !== 'string' || !/^[0-9a-f]{64}$/.test(expectedEventId)) {
        return Promise.resolve({ status: 'unavailable' });
      }
      return new Promise(resolve => {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        const timer = setTimeout(() => { pending = undefined; resolve({ status: 'unavailable' }); }, ${DISCOVERY_LEASE_MS + 5_000});
        pending = { id, timer, resolve };
        parent.postMessage({ type, id, address, expectedEventId, token, ...(action ? {action} : {}) }, '*');
      });
    };
    const operations = [];
    let operating = false, opening = false;
    const pump = () => {
      if (operating || !operations.length) return;
      operating = true;
      const job = operations.shift();
      open(job.address, job.eventId, job.action).then(job.resolve, () => job.resolve({status: 'unavailable'}))
        .finally(() => {operating = false; pump();});
    };
    const schedule = (address, eventId, action) => new Promise(resolve => {
      const read = action === 'pin-state';
      if (operations.filter(job => (job.action === 'pin-state') === read).length >= (read ? 32 : 4)) {
        resolve({status: read ? 'unavailable' : 'busy'}); return;
      }
      const job = {address, eventId, action, resolve};
      const firstRead = operations.findIndex(job => job.action === 'pin-state');
      if (!read && firstRead >= 0) operations.splice(firstRead, 0, job);
      else operations.push(job);
      pump();
    });
    const launch = (address, eventId) => {
      if (opening) return Promise.resolve({status: 'busy'});
      opening = true;
      return schedule(address, eventId).finally(() => { opening = false; });
    };
    const pinState = (address, eventId) => {
      return schedule(address, eventId, 'pin-state').then(result =>
        result.status === 'pinned' || result.status === 'unpinned' ? result : {status: 'unavailable'});
    };
    ${catalogEnabled ? catalogPagePrelude + (bundled ? recommendationsPrelude : '') : ''}
    Object.defineProperty(window, 'hypergolic', { value: Object.freeze({
      publishedOpen: Object.freeze({ version: 1, open: launch, pin: (address, eventId) => schedule(address, eventId, 'pin'), unpin: (address, eventId) => schedule(address, eventId, 'unpin'), pinState })${catalogEnabled ? (bundled ? ', catalogPage, recommendations' : ', catalogPage') : ''}
    }) });
  })();</script>`;
  return html.replace(/(<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>)/i, match => match + script);
}

export function createDiscoveryOpenReceiver(source: Window, native: ReturnType<typeof createNativeClient>,
  token: string, live: () => boolean): (value: unknown) => void {
  let pending = false;
  return value => {
    if (!live() || !value || typeof value !== 'object' || (Object.keys(value).length !== 5 && Object.keys(value).length !== 6)) return;
    const { token: presented, ...request } = value as Record<string, unknown>;
    if (presented !== token) return;
    let message;
    try { message = parseDiscoveryOpen(request); }
    catch {
      const { id } = request;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)) source.postMessage({ type: RESULT, id, status: 'unavailable' }, '*');
      return;
    }
    const { id } = message;
    if (pending) { source.postMessage({ type: RESULT, id, status: 'busy' }, '*'); return; }
    pending = true;
    const wireId = 'published-open-' + crypto.randomUUID();
    const send = (status: unknown) => {
      if (live() && discoveryOpenOutcome(status)) source.postMessage({ type: RESULT, id, status }, '*');
    };
    const wrapper = { type: 'routing.call', id: wireId, message };
    void native.request(wrapper, undefined, DISCOVERY_LEASE_MS + 3_000)
      .then(reply => {
        if (!('response' in reply) || !discoveryOpenOutcome(reply.response)) throw new Error('Invalid published open response');
        send(reply.response);
      }).catch(error => {
        if (!(error instanceof NativeRequestRevoked)) send('unavailable');
      }).finally(() => { pending = false; });
  };
}
