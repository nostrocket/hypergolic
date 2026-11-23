import {classifyResourceBytes} from './resource-mime.ts';
import {RESOURCE_LIMITS, ResourceError} from './resource-contract.ts';

/** Resolution and Blossom hash verification happen before any image conversion. */
export async function prepareResourceBytes(body: Uint8Array<ArrayBuffer>,
  rasterize?: (svg: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>) {
  if (!(body instanceof Uint8Array) || body.length > RESOURCE_LIMITS.fileBytes) throw new ResourceError('too-large');
  try {
    return {mime:classifyResourceBytes(body), bytes:body};
  } catch (error) {
    if (!(error instanceof ResourceError) || error.code !== 'decode-failed' || !rasterize || !body.length) throw error;
    const prefix = new TextDecoder().decode(body.subarray(0, 1024)).trimStart();
    if (!/^(?:<svg[\s/>]|<\?xml\s|<!--)/.test(prefix)) throw error;
    if (body.length > 256 * 1024) throw new ResourceError('too-large');
  }
  try {
    const png = await rasterize(body);
    if (png.length > RESOURCE_LIMITS.fileBytes || classifyResourceBytes(png) !== 'image/png') throw new Error();
    return {mime:'image/png', bytes:png};
  } catch { throw new ResourceError('decode-failed'); }
}
