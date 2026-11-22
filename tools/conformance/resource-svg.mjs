import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createResourceAdapter} from '../../runtime/src/resource-adapter.ts';
import {createResourceBroker} from '../../src/resources/resource-broker.ts';
import {classifyResourceBytes} from '../../src/resources/resource-mime.ts';
import {createResourceService} from '../../src/resources/resource-service.ts';
import {createResourceTransfers} from '../../src/resources/resource-transfers.ts';

export async function observeResourceSvg() {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>';
  const urls = ['data:image/svg+xml,' + encodeURIComponent(svg), 'data:application/octet-stream;base64,AP8=', 'data:image/png;base64,' + png];
  const session = randomUUID();
  const registration = {sessionId:session, generation:session, instanceId:session, epoch:0,
    user:'1'.repeat(64), publisher:'2'.repeat(64), appId:'svg-check', version:'3'.repeat(64), fixture:'published', domains:['resource']};
  const authority = {nativeToken:randomUUID(), assertActive() {}};
  const service = createResourceService({https:() => assert.fail('Unexpected network request'), servers:() => [], sha256:() => assert.fail('Unexpected hash fetch')});
  const broker = createResourceBroker({service, transfers:createResourceTransfers(randomUUID)}, {registration, assertActive:authority.assertActive});
  try {
    const adapter = createResourceAdapter({async request(message) {
      const reply = await broker.dispatch(message, authority);
      assert.equal(typeof reply, 'string');
      return JSON.parse(reply);
    }}, () => () => true);
    const replies = [];
    await adapter({message:{type:'resource.bytesMany', id:'mixed', urls}, send:reply => replies.push(reply)});
    assert.equal(replies.length, 1);
    const [{type, id, items}] = replies;
    assert.equal(type, 'resource.bytesMany.result');
    assert.equal(id, 'mixed');
    assert.deepEqual(items.map(item => item.url), urls);
    const [illustration, unsupported, raster] = items;
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, 'decode-failed');
    assert.equal(raster.ok, true);
    assert.equal(raster.mime, 'image/png');
    assert.equal(raster.blob.type, raster.mime);
    assert.deepEqual(Buffer.from(await raster.blob.arrayBuffer()), Buffer.from(png, 'base64'));
    if (!illustration.ok) {
      assert.equal(illustration.error, 'decode-failed');
      assert.equal('blob' in illustration, false);
      return false;
    }
    assert.ok(['image/png', 'image/webp'].includes(illustration.mime));
    assert.equal(illustration.blob.type, illustration.mime);
    const bytes = new Uint8Array(await illustration.blob.arrayBuffer());
    assert.equal(classifyResourceBytes(bytes), illustration.mime);
    const {chromium} = createRequire(new URL('../../runtime/package.json', import.meta.url))('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const pixels = await page.evaluate(async url => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return {width:image.width, height:image.height, rgba:Array.from(context.getImageData(0, 0, 1, 1).data)};
      }, 'data:' + illustration.mime + ';base64,' + Buffer.from(bytes).toString('base64'));
      assert.equal(pixels.width, 2);
      assert.equal(pixels.height, 2);
      const [red, green, blue, alpha] = pixels.rgba;
      assert.ok(red > 240 && green < 16 && blue < 16 && alpha === 255, 'Expected an opaque red illustration');
    } finally { await browser.close(); }
    return true;
  } finally {
    broker.revoke();
    service.revokeAll();
  }
}
