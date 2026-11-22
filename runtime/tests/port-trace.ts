import type {Page} from '@playwright/test';

// Observe only the shell end of the real channel. The guest keeps its port private.
export async function tracePort(page: Page, types: string[]) {
  await page.addInitScript(types => {
    if (window !== top) return;
    const trace = {requests:[] as any[], replies:[] as any[]};
    (window as any).portTrace = trace;
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow ||
          event.data?.type !== 'napplet.hello' || event.ports.length !== 1) return;
      const port = event.ports[0]!;
      port.addEventListener('message', request => {
        if (types.includes(request.data?.type)) trace.requests.push(request.data);
      });
      const send = port.postMessage.bind(port);
      port.postMessage = (value: any) => {
        if (types.includes(value?.type)) trace.replies.push(value);
        send(value);
      };
    });
  }, types);
}
