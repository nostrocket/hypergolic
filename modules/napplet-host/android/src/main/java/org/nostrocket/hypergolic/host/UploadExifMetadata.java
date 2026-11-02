package org.nostrocket.hypergolic.host;

import java.util.ArrayDeque;
import java.util.HashSet;

/** Bounded TIFF/Exif directory validation; personal metadata is never copied into output. */
final class UploadExifMetadata {
  private record Directory(int offset, boolean primary) {}
  private static final int[] WIDTHS = {0,1,1,2,4,8,1,1,2,4,8,4,8};
  private UploadExifMetadata() {}
  /** Returns primary orientation 1..8, or zero for invalid/unsupported metadata. */
  static int orientation(byte[] bytes, int start, int length) {
    if (bytes == null || start < 0 || length < 14 || length > 256 * 1024 || start > bytes.length - length) return 0;
    boolean little = bytes[start] == 'I' && bytes[start + 1] == 'I';
    if (!little && !(bytes[start] == 'M' && bytes[start + 1] == 'M')) return 0;
    if (shortNumber(bytes, start + 2, little) != 42) return 0;
    long first = number(bytes, start + 4, little); if (first < 8 || first > length - 6) return 0;
    var pending = new ArrayDeque<Directory>(); var seen = new HashSet<Integer>();
    pending.add(new Directory((int)first, true)); int orientation = 1, total = 0;
    while (!pending.isEmpty()) {
      Directory item = pending.removeFirst(); int offset = item.offset;
      if (seen.size() >= 32 || !seen.add(offset) || offset < 8 || offset > length - 6) return 0;
      int directory = start + offset, count = shortNumber(bytes, directory, little);
      if (count > 128 || (total += count) > 1024 || count * 12L + 6 > length - offset) return 0;
      var tags = new HashSet<Integer>(); long thumbnailOffset = -1, thumbnailLength = -1;
      for (int index = 0; index < count; index++) {
        int entry = directory + 2 + index * 12, tag = shortNumber(bytes, entry, little), type = shortNumber(bytes, entry + 2, little);
        long values = number(bytes, entry + 4, little);
        if (!tags.add(tag) || type < 1 || type >= WIDTHS.length || values == 0) return 0;
        long size = values * WIDTHS[type], value = number(bytes, entry + 8, little);
        if (size > 4 && (value < 8 || value > length || size > length - value)) return 0;
        if (tag == 274) {
          int rotation = shortNumber(bytes, entry + 8, little);
          if (type != 3 || values != 1 || rotation < 1 || rotation > 8) return 0;
          if (item.primary) orientation = rotation;
        }
        if (tag == 34665 || tag == 34853 || tag == 40965) {
          if (type != 4 || values != 1 || value < 8 || value > length - 6) return 0;
          pending.add(new Directory((int)value, false));
        }
        if (tag == 513 || tag == 514) {
          if (type != 4 || values != 1) return 0;
          if (tag == 513) thumbnailOffset = value; else thumbnailLength = value;
        }
      }
      if (thumbnailOffset != -1 || thumbnailLength != -1) {
        if (thumbnailOffset < 8 || thumbnailLength < 4 || thumbnailOffset > length || thumbnailLength > length - thumbnailOffset) return 0;
        int from = start + (int)thumbnailOffset, to = from + (int)thumbnailLength;
        if ((bytes[from] & 255) != 255 || (bytes[from + 1] & 255) != 216 || (bytes[to - 2] & 255) != 255 || (bytes[to - 1] & 255) != 217) return 0;
      }
      long next = number(bytes, directory + 2 + count * 12, little);
      if (next != 0) {if (next < 8 || next > length - 6) return 0; pending.add(new Directory((int)next, false));}
    }
    return orientation;
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
