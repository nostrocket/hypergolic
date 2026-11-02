import { ResourceError, RESOURCE_LIMITS } from './resource-contract.ts';

const jpegFrames = new Set([192,193,194,195,197,198,199,201,202,203,205,206,207]);
const bad = (): never => { throw new ResourceError('decode-failed'); };
const ascii = (bytes: Uint8Array, start: number, value: string): boolean =>
  bytes.length >= start + value.length && [...value].every((char, i) => bytes[start + i] === char.charCodeAt(0));
function dimensions(width: number, height: number): void {
  if (!width || !height || width > 4096 || height > 4096) bad();
}
/** T.81 marker headers only: reject unknown dimensions before platform decode. */
function jpegDimensions(bytes: Uint8Array, view: DataView): void {
  let cursor = 2;
  while (cursor < bytes.length) {
    if (bytes[cursor++] !== 255) return bad();
    while (bytes[cursor] === 255) cursor++;
    const marker = bytes[cursor++];
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 218) return bad();
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (cursor + 2 > bytes.length) return bad();
    const length = view.getUint16(cursor);
    if (length < 2 || length > bytes.length - cursor) return bad();
    if (jpegFrames.has(marker)) {
      if (length < 8 || length !== 8 + 3 * bytes[cursor + 7]!) return bad();
      dimensions(view.getUint16(cursor + 5), view.getUint16(cursor + 3));return;
    }
    cursor += length;
  }
  return bad();
}
/** RFC 9649 canvas dimensions; this is not a codec validator. */
function webpDimensions(bytes: Uint8Array, view: DataView): void {
  if (bytes.length < 20) return bad();
  const length = view.getUint32(16, true);
  if (length > bytes.length - 20 || (length & 1) && length === bytes.length - 20) return bad();
  if (ascii(bytes,12,'VP8X')) {
    if (length !== 10 || bytes[21] !== 0 || bytes[22] !== 0 || bytes[23] !== 0) return bad();
    const uint24 = (offset: number) => bytes[offset]! + bytes[offset+1]! * 256 + bytes[offset+2]! * 65536;
    dimensions(uint24(24)+1,uint24(27)+1);return;
  }
  if (ascii(bytes,12,'VP8L')) {
    if (length < 5 || bytes[20] !== 47) return bad();
    const bits = view.getUint32(21,true);
    if (bits >>> 29 !== 0) return bad();
    dimensions((bits & 16383)+1,((bits >>> 14) & 16383)+1);return;
  }
  if (ascii(bytes,12,'VP8 ')) {
    if (length < 10 || (bytes[20]! & 1) !== 0 || !ascii(bytes,23,'\x9d\x01\x2a')) return bad();
    dimensions(view.getUint16(26,true) & 16383,view.getUint16(28,true) & 16383);return;
  }
  return bad();
}
/** Byte classification, never an upstream Content-Type. Native/browser decoding remains separately tested. */
export function classifyResourceBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RESOURCE_LIMITS.fileBytes) throw new ResourceError('too-large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && ascii(bytes, 1, 'PNG\r\n\x1a\n') && bytes[0] === 137 && ascii(bytes, 12, 'IHDR')) {
    dimensions(view.getUint32(16), view.getUint32(20)); return 'image/png';
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) {
    dimensions(view.getUint16(6, true), view.getUint16(8, true)); return 'image/gif';
  }
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) { jpegDimensions(bytes,view);return 'image/jpeg'; }
  if (bytes.length >= 16 && ascii(bytes, 0, 'RIFF') && view.getUint32(4, true) + 8 === bytes.length) {
    if (ascii(bytes, 8, 'WEBP')) { webpDimensions(bytes,view);return 'image/webp'; }
    if (ascii(bytes, 8, 'WAVE')) return 'audio/wav';
  }
  if (bytes.length >= 10 && ascii(bytes, 0, 'ID3') || bytes.length >= 4 && bytes[0] === 255 &&
    (bytes[1]! & 224) === 224 && (bytes[1]! & 24) !== 8 && (bytes[1]! & 6) !== 0 &&
    (bytes[2]! & 240) !== 0 && (bytes[2]! & 240) !== 240 && (bytes[2]! & 12) !== 12) return 'audio/mpeg';
  if (bytes.length >= 16 && ascii(bytes, 4, 'ftyp')) {
    const size = view.getUint32(0);
    if (size < 16 || size > bytes.length || size > 4096 || (size - 16) % 4 !== 0) return bad();
    if (ascii(bytes, 8, 'M4A ')) return 'audio/mp4';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].some(brand => ascii(bytes, 8, brand))) return 'video/mp4';
    return bad();
  }
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  // A leading text/XML probe rejects active document bytes even with a lying server header.
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bad(); }
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<') || /^[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return bad();
  if (/^[{[]/.test(trimmed)) { try { JSON.parse(text); return 'application/json'; } catch { return bad(); } }
  return 'text/plain';
}
