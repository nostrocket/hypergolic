import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceError } from '../../src/resources/resource-contract.ts';
import { classifyResourceBytes } from '../../src/resources/resource-mime.ts';

function glb(source: string, trailingChunks = 0): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(source.padEnd(Math.ceil(source.length / 4) * 4));
  const bytes = new Uint8Array(20 + json.length + trailingChunks * 8);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  return bytes;
}

test('GLB requires valid UTF-8 JSON and a v2 asset within the bounded chunk profile', () => {
  const asset = '{"asset":{"version":"2.0"}}';
  assert.equal(classifyResourceBytes(glb(asset, 15)), 'model/gltf-binary');
  const invalidUtf8 = glb(asset);
  invalidUtf8[22] = 0xff;
  for (const invalid of [
    invalidUtf8, glb('{no}'), glb('{"asset":{"version":"1.0"}}'), glb('{}'),
    glb(asset, 16), glb(asset.padEnd(2 * 1024 * 1024 + 4)),
  ]) {
    assert.throws(() => classifyResourceBytes(invalid), error =>
      error instanceof ResourceError && error.code === 'decode-failed');
  }
});
