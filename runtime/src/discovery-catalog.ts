import { CATALOG_PAGE, parseCatalogPage, parseCatalogPageRequest } from '../../src/napplets/catalog-page-contract';
import { NativeRequestRevoked, type createNativeClient } from './native-client';

const RESULT = CATALOG_PAGE + '.result';

/** This projection is inserted only beside the exact Discover open projection. */
export const catalogPagePrelude = `
    const catalogPage = (() => {
      const type = '${CATALOG_PAGE}';
      let pending;
      window.addEventListener('message', event => {
        const data = event.data;
        if (!pending || !event.isTrusted || event.source !== parent ||
            data?.type !== type + '.result' || data.id !== pending.id || Object.keys(data).length !== 3) return;
        const reply = pending;
        pending = undefined;
        clearTimeout(reply.timer);
        if (data.page) reply.resolve(data.page);
        else reply.reject(new Error('Catalog paging unavailable'));
      });
      const read = (reset, round, after) => {
        if (pending) return Promise.reject(new Error('Catalog paging busy'));
        return new Promise((resolve, reject) => {
          const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
          const timer = setTimeout(() => { pending = undefined; reject(new Error('Catalog paging unavailable')); }, 27000);
          pending = {id, timer, resolve, reject};
          parent.postMessage({type, id, reset, round, after, token}, '*');
        });
      };
      return Object.freeze({version: 1, read});
    })();
`;

export function createCatalogPageReceiver(source: Window, native: ReturnType<typeof createNativeClient>,
  token: string, live: () => boolean): (value: unknown) => void {
  let pending = false;
  return value => {
    if (!live() || !value || typeof value !== 'object' || Object.keys(value).length !== 6) return;
    const {token: presented, ...fields} = value as Record<string, unknown>;
    if (presented !== token) return;
    let request;
    try {request = parseCatalogPageRequest(fields);} catch {return;}
    const {id} = request;
    const send = (page: ReturnType<typeof parseCatalogPage> | null) => {
      if (live()) source.postMessage({type: RESULT, id, page}, '*');
    };
    if (pending) {send(null); return;}
    pending = true;
    void native.request(request, undefined, 26_000).then(reply => send(parseCatalogPage('result' in reply ? reply.result : undefined)))
      .catch(error => {if (!(error instanceof NativeRequestRevoked)) send(null);})
      .finally(() => {pending = false;});
  };
}
