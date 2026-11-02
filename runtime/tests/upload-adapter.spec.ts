import {test, expect, type Page} from '@playwright/test';
// Genuine SDK -> Kehto -> actual private byte adapter/client, controlled native port only.
async function open(page: Page) {
  await page.goto('/tests/capabilities/index.html?upload');
  const frame = page.frames().find(value => value.parentFrame()); if (!frame) throw new Error('No sandbox frame');
  await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
  return frame;
}
test('genuine SDK carries Blob and ArrayBuffer into bounded private chunks and receives public-only status', async ({page}) => {
  const frame = await open(page);
  const initial = await frame.evaluate(async () => {
    const api = (window as any).napplet; (window as any).updates = [];
    api.upload.onStatus((value: unknown) => (window as any).updates.push(value));
    const bytes = new Uint8Array(256 * 1024 + 3); bytes[0] = 7; bytes[bytes.length - 1] = 9;
    return api.upload.upload({data: new Blob([bytes], {type: 'application/octet-stream'}), filename: 'file.bin', caption: 'selected', metadata: {purpose: 'fixture'}});
  });
  expect(initial).toEqual({ok: true, uploadId: 'public-upload-one', status: 'pending', rail: 'blossom'});
  const proof = await page.evaluate(() => {
    const state = (window as any).lab.uploadState;
    return {length: state.body.length, first: state.body[0], last: state.body.at(-1), requests: state.requests.map((value: any) =>
      ({...value, ...(value.base64 ? {base64: '<omitted>', encodedLength: value.base64.length} : {})}))};
  });
  expect(proof.length).toBe(256 * 1024 + 3); expect(proof.first).toBe(7); expect(proof.last).toBe(9);
  expect(proof.requests.map((value: any) => value.type)).toEqual(['upload.__begin', 'upload.__append', 'upload.__append', 'upload.__seal']);
  expect(proof.requests[0].request).toEqual({rail: 'blossom', filename: 'file.bin', caption: 'selected', metadata: {purpose: 'fixture'}});
  expect(proof.requests[0]).not.toHaveProperty('data'); expect(proof.requests[1].offset).toBe(0); expect(proof.requests[2].offset).toBe(256 * 1024);
  await page.evaluate(() => (window as any).lab.uploadPush({ok: true, uploadId: 'public-upload-one', status: 'uploading', rail: 'blossom', bytesSent: 3, bytesTotal: 256 * 1024 + 3}));
  await expect.poll(() => frame.evaluate(() => (window as any).updates.length)).toBe(1);
  expect(await frame.evaluate(() => JSON.stringify((window as any).received))).not.toContain('aaaaaaaa-aaaa');
  const bufferResult = await frame.evaluate(async () => {
    const bytes = new Uint8Array([1, 2, 3]); const pending = (window as any).napplet.upload.upload({data: bytes.buffer}); bytes.fill(8); return pending;
  });
  expect(bufferResult.status).toBe('pending'); expect(await page.evaluate(() => (window as any).lab.uploadState.body)).toEqual([1,2,3]);
});

test('denied staging and wrong chunk cursor fail without seal or exposing private tokens', async ({page}) => {
  const frame = await open(page);
  await page.evaluate(() => { (window as any).lab.uploadState.mode = 'deny'; });
  const denied = await frame.evaluate(() => (window as any).napplet.upload.upload({data: new Uint8Array([1]).buffer}).then(() => 'unexpected', (error: Error) => error.message));
  expect(denied).toBe('policy denied');
  await page.evaluate(() => {(window as any).lab.uploadState.mode = 'wrong-cursor'; (window as any).lab.uploadState.requests = [];});
  const rejected = await frame.evaluate(() => (window as any).napplet.upload.upload({data: new Uint8Array([2]).buffer}).then(() => 'unexpected', (error: Error) => error.message));
  expect(rejected).toBe('upload failed');
  await expect.poll(() => page.evaluate(() => (window as any).lab.uploadState.requests.map((value: any) => value.type))).toEqual(['upload.__begin', 'upload.__append', 'upload.__cancel']);
  expect(await frame.evaluate(() => JSON.stringify((window as any).received))).not.toContain('aaaaaaaa-aaaa');
});

test('undeclared private operations and caller authority never reach the native carrier', async ({page}) => {
  const frame = await open(page);
  await frame.evaluate(() => {
    parent.postMessage({type: 'upload.__begin', id: 'forged', request: {}, byteLength: 1}, '*');
    parent.postMessage({type: 'upload.upload', id: 'authority', request: {data: new Uint8Array([1]).buffer, destination: 'https://other.example.org'}}, '*');
  });
  await expect.poll(() => frame.evaluate(() => (window as any).received.some((value: any) => value.id === 'authority'))).toBe(true);
  expect(await page.evaluate(() => (window as any).lab.uploadState.requests)).toEqual([]);
});

test('upload status rejects foreign generation, ID, private fields and duplicate delivery', async ({page}) => {
  const frame = await open(page);
  await frame.evaluate(async () => {
    (window as any).updates = []; const api = (window as any).napplet;
    api.upload.onStatus((value: unknown) => (window as any).updates.push(value)); await api.upload.upload({data: new Uint8Array([1]).buffer});
  });
  await page.evaluate(() => {
    const lab = (window as any).lab, valid = {ok: true, uploadId: 'public-upload-one', status: 'uploading', rail: 'blossom', bytesSent: 1, bytesTotal: 1};
    for (const [status, extra] of [[valid, {sessionId: 'foreign'}], [{...valid, uploadId: 'foreign'}, {}], [{...valid, token: 'private'}, {}]]) {
      lab.uploadState.seal.delivery = 0; lab.uploadPush(status, extra);
    }
    lab.uploadState.seal.delivery = 0; lab.uploadPush(valid);
    lab.uploadState.seal.delivery = 0; lab.uploadPush(valid);
  });
  await expect.poll(() => frame.evaluate(() => (window as any).updates.length)).toBe(1);
});

test('captured original recipient loses all status delivery after unregister', async ({page}) => {
  const frame = await open(page);
  await frame.evaluate(async () => {
    (window as any).updates = []; const api = (window as any).napplet;
    api.upload.onStatus((value: unknown) => (window as any).updates.push(value)); await api.upload.upload({data: new Uint8Array([1]).buffer});
  });
  await page.evaluate(() => {
    const lab = (window as any).lab; lab.unregister(); lab.uploadPush({ok: false, uploadId: 'public-upload-one', status: 'cancelled', rail: 'blossom', error: 'user cancelled'});
  });
  expect(await frame.evaluate(() => (window as any).updates)).toEqual([]);
});
