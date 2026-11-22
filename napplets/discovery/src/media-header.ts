import type { ImageMime } from './catalog.ts';

export const MAX_DIMENSION = 4096;
const MAX_PIXELS = 8 * 1024 * 1024;
const jpegFrames = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
type Dimensions = { width: number; height: number };

function bounded(width: number, height: number): Dimensions | undefined {
  if (width && height && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS) {
    return { width, height };
  }
}

function tag(bytes: Uint8Array, start: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + 4));
}

function png(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || tag(bytes, 12) !== 'IHDR' ||
    !bounded(view.getUint32(16), view.getUint32(20))) return false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    const type = tag(bytes, offset + 4);
    if (size > bytes.length - offset - 12 || type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false;
    offset += size + 12;
    if (type === 'IEND') return size === 0 && offset === bytes.length;
  }
  return false;
}

/** T.81 marker headers before the image scan. Zero height can defer dimensions to DNL. */
function jpeg(bytes: Uint8Array, view: DataView): boolean {
  let frame = false;
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (!marker || marker === 216 || marker === 217 || offset + 2 > bytes.length) return false;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const size = view.getUint16(offset);
    if (size < 2 || size > bytes.length - offset) return false;
    if (marker === 218) return frame;
    if (jpegFrames.has(marker)) {
      if (frame || size < 8 || size !== 8 + 3 * bytes[offset + 7]! ||
        !bounded(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false;
      frame = true;
    }
    offset += size;
  }
  return false;
}

function webpRaster(bytes: Uint8Array, view: DataView, type: string, offset: number, size: number): Dimensions | undefined {
  if (type === 'VP8L') {
    if (size < 5 || bytes[offset] !== 47) return;
    const bits = view.getUint32(offset + 1, true);
    if (bits >>> 29 === 0) return bounded((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
  } else if (size >= 10 && (bytes[offset]! & 1) === 0 && bytes[offset + 3] === 157 &&
    bytes[offset + 4] === 1 && bytes[offset + 5] === 42) {
    return bounded(view.getUint16(offset + 6, true) & 16383, view.getUint16(offset + 8, true) & 16383);
  }
}

/** RFC 9649 static WebP. Bound both the extended canvas and the raster header. */
function webp(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length || tag(bytes, 8) !== 'WEBP') return false;
  let canvas: Dimensions | undefined;
  let raster: Dimensions | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const next = data + size + (size & 1);
    if (next > bytes.length || type === 'ANIM' || type === 'ANMF') return false;
    if (type === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[data]! & 2) !== 0 ||
        bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) return false;
      const uint24 = (start: number) => bytes[start]! + bytes[start + 1]! * 256 + bytes[start + 2]! * 65536;
      canvas = bounded(uint24(data + 4) + 1, uint24(data + 7) + 1);
      if (!canvas) return false;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (raster) return false;
      raster = webpRaster(bytes, view, type, data, size);
      if (!raster) return false;
    }
    offset = next;
  }
  return offset === bytes.length && Boolean(raster &&
    (!canvas || (canvas.width === raster.width && canvas.height === raster.height)));
}

/** Reject oversized images before a browser decoder sees any bytes. */
export function imageMime(bytes: Uint8Array): ImageMime | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.length >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && png(bytes, view)) {
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && jpeg(bytes, view)) return 'image/jpeg';
  if (tag(bytes, 0) === 'RIFF' && webp(bytes, view)) return 'image/webp';
}
