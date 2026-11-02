package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Set;
import java.util.HashSet;
import java.util.zip.CRC32;

/** Removes only non-rendering PNG metadata; pixel, color and orientation validation remains native. */
final class UploadPngMetadata {
  private static final byte[] SIGNATURE = {(byte)137,80,78,71,13,10,26,10};
  private static final Set<String> CONTENT = Set.of("IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM");
  private static final Set<String> TEXT = Set.of("tEXt", "zTXt", "iTXt");
  private UploadPngMetadata() {}
  static byte[] prepare(byte[] input) {
    if (input == null || input.length < 57 || input.length > NativeUploadAuthority.MAX_BYTES ||
      !Arrays.equals(Arrays.copyOf(input, 8), SIGNATURE)) return null;
    var output = new ByteArrayOutputStream(input.length); output.writeBytes(SIGNATURE);
    int cursor = 8, chunks = 0; boolean pixels = false, endedPixels = false, ended = false, exif = false, time = false;
    while (cursor <= input.length - 12) {
      if (++chunks > 4096 || ended) return null;
      long rawLength = number(input, cursor, false); if (rawLength > input.length - cursor - 12) return null;
      int length = (int)rawLength, start = cursor + 8;
      String type = new String(input, cursor + 4, 4, StandardCharsets.US_ASCII);
      if (!type.matches("[A-Za-z]{2}[A-Z][A-Za-z]") || (cursor == 8 && !type.equals("IHDR"))) return null;
      var crc = new CRC32(); crc.update(input, cursor + 4, length + 4);
      if (crc.getValue() != number(input, start + length, false)) return null;
      if (type.equals("IDAT")) {if (endedPixels) return null; pixels = true;}
      else if (pixels) endedPixels = true;
      if (CONTENT.contains(type)) output.write(input, cursor, length + 12);
      else if (TEXT.contains(type)) {
        // These containers affect neither pixels nor color; compressed text is never inflated.
      } else if (type.equals("eXIf")) {
        if (exif || !neutralOrientation(input, start, length)) return null; exif = true;
      } else if (type.equals("tIME")) {
        if (time || length != 7 || input[start + 2] < 1 || input[start + 2] > 12 || input[start + 3] < 1 ||
          input[start + 3] > 31 || (input[start + 4] & 255) > 23 || (input[start + 5] & 255) > 59 || (input[start + 6] & 255) > 60) return null;
        time = true;
      } else return null;
      cursor += length + 12;
      if (type.equals("IEND")) {if (cursor != input.length) return null; ended = true;}
    }
    return ended && cursor == input.length ? UploadPngProfile.prepare(output.toByteArray()) : null;
  }
  private static boolean neutralOrientation(byte[] bytes, int start, int length) {
    if (length < 14) return false;
    boolean little = bytes[start] == 'I' && bytes[start + 1] == 'I';
    if (!little && !(bytes[start] == 'M' && bytes[start + 1] == 'M')) return false;
    if (shortNumber(bytes, start + 2, little) != 42) return false;
    long offset = number(bytes, start + 4, little); if (offset < 8 || offset > length - 6) return false;
    int directory = start + (int)offset, count = shortNumber(bytes, directory, little);
    if (count > 128 || count * 12L + 6 > length - offset) return false;
    boolean orientation = false; var tags = new HashSet<Integer>();
    int[] widths = {0,1,1,2,4,8,1,1,2,4,8,4,8};
    for (int index = 0; index < count; index++) {
      int entry = directory + 2 + index * 12;
      int tag = shortNumber(bytes, entry, little), type = shortNumber(bytes, entry + 2, little);
      long values = number(bytes, entry + 4, little);
      if (!tags.add(tag) || type < 1 || type >= widths.length || values == 0) return false;
      long size = values * widths[type];
      if (size > 4) {
        long position = number(bytes, entry + 8, little);
        if (position < 8 || position > length || size > length - position) return false;
      }
      if (tag == 274) {
        if (orientation || shortNumber(bytes, entry + 2, little) != 3 || number(bytes, entry + 4, little) != 1 ||
          shortNumber(bytes, entry + 8, little) != 1) return false;
        orientation = true;
      }
    }
    // Additional image directories may change which orientation a decoder selects.
    return number(bytes, directory + 2 + count * 12, little) == 0;
  }
  private static int shortNumber(byte[] bytes, int offset, boolean little) {
    return little ? (bytes[offset] & 255) | (bytes[offset + 1] & 255) << 8 : (bytes[offset] & 255) << 8 | (bytes[offset + 1] & 255);
  }
  private static long number(byte[] bytes, int offset, boolean little) {
    long value = 0;
    for (int index = 0; index < 4; index++) value = value << 8 | (bytes[offset + (little ? 3 - index : index)] & 255L);
    return value;
  }
}
