import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageMime } from '../src/media-header.ts';

// Minimal header containers. Actual browser decoding is covered by the Chromium/WebKit fixture.
function png(width: number, height: number) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}
function jpeg(width: number, height: number) {
  const bytes = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 255, 218, 0, 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}
function webp(canvas: number, raster: number) {
  const bytes = new Uint8Array(44);
  const encode = new TextEncoder();
  const view = new DataView(bytes.buffer);
  bytes.set(encode.encode('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(encode.encode('WEBPVP8X'), 8);
  view.setUint32(16, 10, true);
  view.setUint16(24, canvas - 1, true);
  bytes.set(encode.encode('VP8L'), 30);
  view.setUint32(34, 5, true);
  bytes[38] = 47;
  view.setUint32(39, raster - 1, true);
  return bytes;
}

test('admits bounded PNG, JPEG and static WebP headers', () => {
  assert.equal(imageMime(png(400, 300)), 'image/png');
  assert.equal(imageMime(jpeg(400, 300)), 'image/jpeg');
  assert.equal(imageMime(webp(400, 400)), 'image/webp');
});

test('rejects compressed dimension abuse before decode and mismatched WebP canvas headers', () => {
  assert.equal(imageMime(png(999999, 999999)), undefined);
  assert.equal(imageMime(png(4096, 4096)), undefined);
  assert.equal(imageMime(jpeg(65535, 65535)), undefined);
  assert.equal(imageMime(jpeg(1, 0)), undefined);
  assert.equal(imageMime(webp(1, 8192)), undefined);
  assert.equal(imageMime(webp(400, 401)), undefined);
  const animated = webp(400, 400);
  animated[20] = 2;
  assert.equal(imageMime(animated), undefined);
});
