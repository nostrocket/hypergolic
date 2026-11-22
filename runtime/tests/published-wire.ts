import {test as base, type Page} from '@playwright/test';
export * from '@playwright/test';

type Part = {text: string; byteLength: number; totalBytes: number; done: boolean};
declare global {
  interface Window {
    guestWire: {windowTypes: string[]; portTypes: string[]; transfers: number};
    publishedPart(bytes: Uint8Array, sequence: number): Part;
    nativeMessage(message: unknown): string;
  }
}

// Emulate the two native host writers, including UTF-8 scalar boundaries.
export const test = base.extend({
  context: async ({context}, use) => {
    await context.addInitScript(() => {
      const cache = new WeakMap<Uint8Array, Part[]>();
      window.publishedPart = (bytes, sequence) => {
        let parts = cache.get(bytes);
        if (!parts) {
          parts = [];
          const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
          for (let start = 0; start < bytes.length;) {
            let end = Math.min(start + 256 * 1024, bytes.length);
            while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
            parts.push({text: decoder.decode(bytes.subarray(start, end)), byteLength: end - start,
              totalBytes: bytes.length, done: end === bytes.length});
            start = end;
          }
          cache.set(bytes, parts);
        }
        return parts[sequence]!;
      };
      window.nativeMessage = value => {
        if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'artifact.chunk') return JSON.stringify(value);
        const {text, ...header} = value as {type: string; text: string};
        return JSON.stringify(header) + '\n' + text;
      };
    });
    await use(context);
  },
});

export async function holdShellReadiness(page: Page) {
  await page.addInitScript(() => {
    if (window !== top) return;
    const wire = window.guestWire = {windowTypes:[] as string[], portTypes:[] as string[], transfers:0};
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow) return;
      wire.windowTypes.push(event.data.type);
      wire.transfers += event.ports.length;
      event.ports[0]?.addEventListener('message', message => {
        wire.portTypes.push(message.data.type);
        if (message.data.type === 'shell.ready') message.stopImmediatePropagation();
      });
    });
  });
  return () => page.evaluate(() => window.guestWire);
}
