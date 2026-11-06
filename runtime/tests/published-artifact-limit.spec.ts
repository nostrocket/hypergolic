import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const generation = '12345678-1234-1234-1234-123456789abc';
const cap = 20 * 1024 * 1024;
const chunkSize = 48 * 1024;
const marker = 'Verified large artifact';
const document = `<!doctype html><html><head></head><body><p>${marker}</p></body></html>`;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const htmlHash = digest(Buffer.concat([Buffer.from(document), Buffer.alloc(cap - document.length, 32)]));

for (const totalBytes of [cap, cap + 1]) {
  test(`published runtime enforces the 20 MiB boundary (${totalBytes} bytes)`, async ({ page }) => {
    await page.addInitScript(({ generation, totalBytes, chunkSize, document, htmlHash, version }) => {
      if (window !== window.top) return;
      const listeners = new Set<(event: { data: string }) => void>();
      const proof = { reads: [] as number[], failures: [] as string[] };
      Object.defineProperty(window, 'artifactLimitProof', { value: proof });
      Object.defineProperty(window, 'HypergolicHost', { value: {
        addEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.delete(listener),
        postMessage(raw: string) {
          const request = JSON.parse(raw);
          if (request.type === 'error') proof.failures.push(request.code);
          if (request.type !== 'artifact.read') return;
          const sequence: number = request.sequence;
          proof.reads.push(sequence);
          const size = Math.min(chunkSize, totalBytes - sequence * chunkSize);
          const payload = sequence === 0 ? document.padEnd(size, ' ') : ' '.repeat(size);
          const data = JSON.stringify({
            type: 'artifact.chunk', sessionId: generation, sequence, base64: btoa(payload),
            byteLength: size, totalBytes, publisher: '1'.repeat(64), appId: 'large-artifact',
            eventId: '2'.repeat(64), version, htmlHash, domains: ['theme'],
            done: (sequence + 1) * chunkSize >= totalBytes,
          });
          for (const listener of listeners) listener({ data });
        },
      } });
    }, { generation, totalBytes, chunkSize, document, htmlHash, version: digest(`${htmlHash} /index.html\n`) });
    await page.goto(`/assets/runtime/index.html?sessionId=${generation}&source=published`);
    if (totalBytes === cap) {
      await expect(page.frameLocator('#napplet').getByText(marker, { exact: true })).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(page.getByRole('alert')).toHaveText('The napplet could not be loaded.');
      await expect(page.locator('iframe')).toHaveCount(0);
    }
    const proof = await page.evaluate(() => Reflect.get(window, 'artifactLimitProof') as { reads: number[]; failures: string[] });
    const count = totalBytes === cap ? Math.ceil(cap / chunkSize) : 1;
    expect(proof.reads).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(proof.failures).toEqual(totalBytes === cap ? [] : ['artifact-integrity']);
  });
}
