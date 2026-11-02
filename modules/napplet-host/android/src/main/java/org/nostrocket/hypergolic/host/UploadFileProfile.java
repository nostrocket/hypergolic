package org.nostrocket.hypergolic.host;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CharacterCodingException;
import java.util.Arrays;
import java.util.Set;

/** Native byte classification; failed photos never become opaque attachments. */
final class UploadFileProfile {
  record Prepared(byte[] bytes, String mimeType, String metadataPolicy) {}
  private UploadFileProfile() {}
  static Prepared prepare(byte[] input) {
    if (input == null || input.length < 1 || input.length > NativeUploadAuthority.MAX_BYTES) return null;
    if (input.length >= 8 && (input[0] & 255) == 137 && text(input, 1, 3).equals("PNG")) {
      byte[] safe = UploadPngMetadata.prepare(input);
      return safe == null ? null : new Prepared(safe, "image/png", "photo-stripped");
    }
    String type = attachmentType(input);
    return type == null ? null : new Prepared(input.clone(), type, "attachment-unchanged");
  }
  static String attachmentType(byte[] input) {
    if (input == null || input.length < 1 || input.length > NativeUploadAuthority.MAX_BYTES) return null;
    if (input.length >= 12 && text(input, 0, 4).equals("RIFF")) {
      // WEBP, including a failed photo, cannot fall through to audio or text.
      if (!text(input, 8, 4).equals("WAVE") || number(input, 4, true) != input.length - 8) return null;
      int cursor = 12, chunks = 0; boolean format = false, data = false;
      while (cursor <= input.length - 8) {
        if (++chunks > 4096) return null;
        long length = number(input, cursor + 4, true);
        if (length > input.length - cursor - 8) return null;
        String tag = text(input, cursor, 4);
        if (tag.equals("fmt ")) {if (format || length < 16) return null; format = true;}
        if (tag.equals("data")) {if (data || length < 1) return null; data = true;}
        cursor += 8 + (int)length + (int)(length & 1);
      }
      return cursor == input.length && format && data ? "audio/wav" : null;
    }
    if (input.length >= 12 && text(input, 4, 4).equals("ftyp")) {
      long first = number(input, 0, false); if (first < 16 || first > input.length || (first - 16) % 4 != 0) return null;
      Set<String> brands = Set.of("isom", "iso2", "mp41", "mp42", "avc1", "M4V ");
      if (!brands.contains(text(input, 8, 4))) return null;
      for (int at = 16; at < first; at += 4) if (!brands.contains(text(input, at, 4))) return null;
      int cursor = 0, boxes = 0; boolean movie = false, data = false;
      while (cursor <= input.length - 8) {
        if (++boxes > 4096) return null;
        long size = number(input, cursor, false); int header = 8;
        if (size == 1) {
          if (cursor > input.length - 16 || number(input, cursor + 8, false) != 0) return null;
          size = number(input, cursor + 12, false); header = 16;
        }
        if (size == 0) size = input.length - cursor;
        if (size < header || size > input.length - cursor) return null;
        String tag = text(input, cursor + 4, 4); movie |= tag.equals("moov"); data |= tag.equals("mdat"); cursor += (int)size;
      }
      return cursor == input.length && movie && data ? "video/mp4" : null;
    }
    if (input.length >= 10 && text(input, 0, 3).equals("ID3")) {
      if ((input[3] & 255) < 2 || (input[3] & 255) > 4) return null;
      int length = 0; for (int at = 6; at < 10; at++) {if (input[at] < 0) return null; length = length << 7 | input[at];}
      int offset = length + 10 + ((input[3] == 4 && (input[5] & 16) != 0) ? 10 : 0);
      return mp3(input, offset) ? "audio/mpeg" : null;
    }
    if (mp3(input, 0)) return "audio/mpeg";
    if (input.length >= 12 && text(input, 0, 5).equals("%PDF-") &&
      (text(input, 5, 3).matches("1\\.[0-9]") || text(input, 5, 3).equals("2.0")) &&
      text(input, Math.max(0, input.length - 1024), Math.min(1024, input.length)).contains("%%EOF")) return "application/pdf";
    if (input.length >= 22 && input[0] == 'P' && input[1] == 'K' &&
      ((input[2] == 3 && input[3] == 4) || (input[2] == 5 && input[3] == 6))) return "application/zip";
    if (input.length > 1024 * 1024) return null;
    try {
      String value = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(input)).toString();
      String start = value.replace("\uFEFF", "").stripLeading();
      if (start.isEmpty() || start.startsWith("<") || start.startsWith("GIF8") || start.startsWith("II*") || start.startsWith("MM")) return null;
      for (int index = 0; index < value.length(); index++) {
        char c = value.charAt(index); if ((c < 32 && c != 9 && c != 10 && c != 13) || c == 127) return null;
      }
      return "text/plain";
    } catch (CharacterCodingException invalid) {return null;}
  }
  private static boolean mp3(byte[] bytes, int offset) {
    if (offset < 0 || offset > bytes.length - 4) return false;
    int a = bytes[offset + 1] & 255, b = bytes[offset + 2] & 255;
    return (bytes[offset] & 255) == 255 && (a & 224) == 224 && (a & 24) != 8 && (a & 6) != 0 &&
      (b >> 4) != 0 && (b >> 4) != 15 && (b & 12) != 12;
  }
  private static String text(byte[] bytes, int start, int length) {return new String(Arrays.copyOfRange(bytes, start, start + length), StandardCharsets.ISO_8859_1);}
  private static long number(byte[] bytes, int offset, boolean little) {
    long value = 0; for (int index = 0; index < 4; index++) value = value << 8 | (bytes[offset + (little ? 3 - index : index)] & 255L); return value;
  }
}
