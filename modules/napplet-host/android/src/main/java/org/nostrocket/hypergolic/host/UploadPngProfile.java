package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/** First tracer profile only: bounded non-interlaced 8-bit RGB/RGBA PNG with no embedded metadata.
 * Unknown ancillary chunks, ICC profiles, EXIF and animation require the later photo preparer.
 * This accepts unchanged known bytes; it never silently strips orientation/color information. */
final class UploadPngProfile {
  private static final byte[] SIGNATURE = {(byte)137,80,78,71,13,10,26,10};
  private UploadPngProfile() {}
  static byte[] prepare(byte[] input) {
    if (input == null || input.length < 57 || input.length > NativeUploadAuthority.MAX_BYTES ||
      !Arrays.equals(Arrays.copyOf(input, 8), SIGNATURE)) return null;
    int cursor = 8, width = 0, height = 0, channels = 0;
    boolean header = false, pixels = false, endedPixels = false, end = false;
    var compressed = new ByteArrayOutputStream();
    var seen = new java.util.HashSet<String>();
    while (cursor <= input.length - 12) {
      long lengthValue = u32(input, cursor); if (lengthValue > input.length - cursor - 12) return null;
      int length = (int)lengthValue;
      String type = new String(input, cursor + 4, 4, StandardCharsets.US_ASCII);
      var crc = new CRC32(); crc.update(input, cursor + 4, length + 4);
      if (crc.getValue() != u32(input, cursor + 8 + length)) return null;
      if (!header && !"IHDR".equals(type) || end) return null;
      if (pixels && !"IDAT".equals(type)) endedPixels = true;
      switch (type) {
        case "IHDR":
          if (header || length != 13) return null;
          long w = u32(input, cursor + 8), h = u32(input, cursor + 12);
          if (w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 4_194_304 || input[cursor + 16] != 8 ||
            input[cursor + 18] != 0 || input[cursor + 19] != 0 || input[cursor + 20] != 0) return null;
          int color = input[cursor + 17] & 255; channels = color == 2 ? 3 : color == 6 ? 4 : 0; if (channels == 0) return null;
          width = (int)w; height = (int)h; header = true; break;
        case "sRGB":
          if (pixels || length != 1 || (input[cursor + 8] & 255) > 3 || !seen.add(type)) return null; break;
        case "gAMA":
          if (pixels || length != 4 || u32(input, cursor + 8) == 0 || !seen.add(type)) return null; break;
        case "cHRM":
          if (pixels || length != 32 || !seen.add(type)) return null; break;
        case "IDAT":
          if (!header || endedPixels) return null;
          compressed.write(input, cursor + 8, length); pixels = true; break;
        case "IEND":
          if (!pixels || length != 0 || cursor + 12 != input.length) return null; end = true; break;
        default: return null;
      }
      cursor += length + 12;
    }
    if (!end || cursor != input.length || !validPixels(compressed.toByteArray(), width, height, channels)) return null;
    return input.clone();
  }
  private static boolean validPixels(byte[] bytes, int width, int height, int channels) {
    int row = width * channels + 1, expected = row * height, total = 0;
    var inflater = new Inflater(); var scratch = new byte[64 * 1024];
    try {
      inflater.setInput(bytes);
      while (!inflater.finished()) {
        int count = inflater.inflate(scratch);
        if (count == 0 || count > expected - total) return false;
        for (int i = 0; i < count; i++) if ((total + i) % row == 0 && (scratch[i] & 255) > 4) return false;
        total += count;
      }
      return total == expected && inflater.getRemaining() == 0;
    } catch (DataFormatException invalid) { return false; }
    finally { inflater.end(); Arrays.fill(scratch, (byte)0); }
  }
  private static long u32(byte[] bytes, int offset) {
    return (bytes[offset]&255L)<<24 | (bytes[offset+1]&255L)<<16 | (bytes[offset+2]&255L)<<8 | bytes[offset+3]&255L;
  }
}
