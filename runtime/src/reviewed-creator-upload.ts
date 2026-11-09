import type {UploadResult} from '../../src/uploads/upload-contract';

type CreatorMetadata = Readonly<{published: boolean; appId: string; aggregateHash: string; domains: readonly string[]}>;
const creatorVersion = '1533e892517b313b316b6137759580cbae0a82ca1c9d1de23f6b2f0f2dea6dea';

/** Runs after the host's Kehto prelude and before the verified publisher script. */
function installCreatorUpload(): void {
  const target = window as Window & {napplet?: {upload?: {upload(request: unknown): Promise<UploadResult>}}};
  const api = target.napplet?.upload;
  if (!api || typeof api.upload !== 'function') return;
  const original = api.upload.bind(api);
  const parent = target.parent;
  const listen = target.addEventListener.bind(target);
  const unlisten = target.removeEventListener.bind(target);
  const delay = target.setTimeout.bind(target);
  const clear = target.clearTimeout.bind(target);
  let waiting = false;

  api.upload = request => {
    if (waiting) return Promise.reject(new Error('quota exceeded'));
    waiting = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let uploadId: string | undefined;
      let early: UploadResult | undefined;
      let deadline: number | undefined;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        waiting = false;
        clear(deadline);
        unlisten('message', onStatus);
        unlisten('pagehide', onPageHide, true);
        return true;
      };
      const finish = (status: UploadResult) => {if (cleanup()) resolve(status);};
      const fail = (error: unknown) => {if (cleanup()) reject(error);};
      const onPageHide = (event: PageTransitionEvent) => {if (event.isTrusted) fail(new Error('user cancelled'));};
      const onStatus = (event: MessageEvent) => {
        if (!event.isTrusted || event.source !== parent || event.data?.type !== 'upload.status.changed') return;
        // The parent already validated this status against its native recipient and upload ID.
        const status: UploadResult | undefined = event.data.status;
        if (!status || !['complete', 'failed', 'cancelled'].includes(status.status)) return;
        if (uploadId === undefined) early = status;
        else if (uploadId === status.uploadId) finish(status);
      };
      listen('message', onStatus);
      listen('pagehide', onPageHide, true);
      const initial = (result: UploadResult) => {
        if (settled) return;
        if (result.status !== 'pending' && result.status !== 'uploading') {
          finish(result);
          return;
        }
        uploadId = result.uploadId;
        const prior = early;
        early = undefined;
        if (prior?.uploadId === uploadId) finish(prior);
        // Native review can last ten minutes, followed by a sixty-second transfer lease.
        else deadline = delay(() => fail(new Error('upload confirmation timed out')), 660_000);
      };
      try {void original(request).then(initial).catch(fail);}
      catch (error) {fail(error);}
    });
  };
}

export function injectCreatorUpload(html: string, metadata: CreatorMetadata): string {
  if (!metadata.published || metadata.appId !== 'emoji-pack-creator' || metadata.aggregateHash !== creatorVersion ||
      !metadata.domains.includes('upload')) return html;
  const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!csp.test(html)) throw new Error('Creator upload compatibility requires host CSP');
  return html.replace(csp, value => `${value}<script data-hypergolic-creator-upload>(${installCreatorUpload.toString()})();</script>`);
}
