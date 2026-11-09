package org.nostrocket.hypergolic.host;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.util.HashSet;
import java.util.Set;

/** Selected finite, self-contained ISO BMFF H.264 and MPEG-4 audio sample profile. */
final class FiniteMp4 {
  private static final Set<Integer> FILE_TYPES = tags("isom", "iso2", "mp41", "mp42", "avc1", "M4V ");
  private static final Set<Integer> TOP = tags("ftyp", "moov", "mdat", "free", "skip", "wide");
  private static final Set<Integer> CONTAINERS = tags("moov", "trak", "mdia", "minf", "dinf", "stbl");
  private static final Set<Integer> LOCAL_CODECS = tags("avc1", "avc3", "mp4a");
  private static final Set<Integer> FORBIDDEN = tags("rmra", "mvex", "pssh", "sinf", "uuid");
  private final RandomAccessFile file;
  private final int length;
  private final MediaHttpsFile.Check check;
  private final ByteBuffer window = ByteBuffer.allocate(8192);
  private int origin = -1, available;
  private int remaining = 4096;
  private boolean movie, duration, data, video;

  private FiniteMp4(RandomAccessFile file, int length, MediaHttpsFile.Check check) {
    this.file = file; this.length = length; this.check = check;
  }
  static boolean accepts(File input, MediaHttpsFile.Check check) {
    try (RandomAccessFile file = new RandomAccessFile(input, "r")) {
      if (file.length() < 24 || file.length() > MediaHttpsFile.MAX_BYTES) return false;
      int length = (int)file.length();
      FiniteMp4 profile = new FiniteMp4(file, length, check);
      Box first = profile.box(0, length);
      return first.type == tag("ftyp") && first.start == 8 && first.end >= 16 && first.end <= 256 && (first.end - 16) % 4 == 0 &&
          FILE_TYPES.contains(profile.uint(8)) && profile.visit(0, length, 0, 0, null) &&
          profile.movie && profile.duration && profile.data && profile.video;
    } catch (IllegalArgumentException | IOException e) { return false; }
  }
  private int offset(int at, int count) throws IOException {
    if (at < 0 || count > length - at) throw new IOException("MP4 read outside file");
    if (origin < 0 || at < origin || count > available - (at - origin)) {
      check.run();
      origin = at;
      available = Math.min(length - at, window.capacity());
      file.seek(at);
      file.readFully(window.array(), 0, available);
    }
    return at - origin;
  }
  private int uint(int at) throws IOException { return window.getInt(offset(at, 4)); }
  private long longValue(int at) throws IOException { return window.getLong(offset(at, 8)); }
  static boolean validDimensions(int width, int height) {
    return width > 0 && height > 0 && Math.min(width, height) <= 2160 && Math.max(width, height) <= 3840;
  }

  private record Box(int type, int start, int end) {}
  private static final class Track { boolean references, descriptions; }
  private static Set<Integer> tags(String... values) {
    Set<Integer> result = new HashSet<>();
    for (String value : values) result.add(tag(value));
    return result;
  }
  private static int tag(String value) {
    return value.charAt(0) << 24 | value.charAt(1) << 16 | value.charAt(2) << 8 | value.charAt(3);
  }
  private Box box(int at, int end) throws IOException {
    if (--remaining < 0 || end - at < 8) throw new IllegalArgumentException();
    long size = Integer.toUnsignedLong(uint(at));
    int header = 8;
    if (size == 1) {
      if (end - at < 16) throw new IllegalArgumentException();
      size = longValue(at + 8); header = 16;
    } else if (size == 0) size = end - at;
    if (size < header || size > end - at) throw new IllegalArgumentException();
    return new Box(uint(at + 4), at + header, at + (int)size);
  }
  private boolean visit(int start, int end, int depth, int parent, Track track) throws IOException {
    if (depth > 6) return false;
    for (int at = start; at < end;) {
      Box b = box(at, end);
      int type = b.type;
      if (FORBIDDEN.contains(type) || depth == 0 && !TOP.contains(type)) return false;
      if (CONTAINERS.contains(type) && !properParent(type, parent)) return false;
      if (type == tag("moov")) { if (depth != 0 || movie) return false; movie = true; }
      if (type == tag("mdat")) { if (depth != 0 || b.start == b.end) return false; data = true; }
      if (type == tag("mvhd")) {
        if (parent != tag("moov") || duration || !validDuration(b)) return false;
        duration = true;
      }
      if (type == tag("trak")) {
        if (depth != 1) return false;
        Track next = new Track();
        if (!visit(b.start, b.end, depth + 1, type, next) || !next.references || !next.descriptions) return false;
      } else if (CONTAINERS.contains(type)) {
        if (!visit(b.start, b.end, depth + 1, type, track)) return false;
      } else if (type == tag("dref") || type == tag("stsd")) {
        if (track == null || parent != (type == tag("dref") ? tag("dinf") : tag("stbl")) || !entries(b, type == tag("dref"), track)) return false;
      }
      at = b.end;
    }
    return true;
  }
  private boolean validDuration(Box box) throws IOException {
    int at = box.start;
    if (box.end - at < 20) return false;
    int version = uint(at) >>> 24;
    if (version != 0 && (version != 1 || box.end - at < 32)) return false;
    long scale = Integer.toUnsignedLong(uint(at + (version == 0 ? 12 : 20)));
    long ticks = version == 0 ? Integer.toUnsignedLong(uint(at + 16)) : longValue(at + 24);
    return scale > 0 && ticks > 0 && ticks <= scale * 3600;
  }
  private static boolean properParent(int type, int parent) {
    if (type == tag("moov")) return parent == 0;
    if (type == tag("trak")) return parent == tag("moov");
    if (type == tag("mdia")) return parent == tag("trak");
    if (type == tag("minf")) return parent == tag("mdia");
    return parent == tag("minf");
  }
  private boolean entries(Box b, boolean references, Track track) throws IOException {
    if (b.end - b.start < 8 || uint(b.start) != 0) return false;
    int count = uint(b.start + 4);
    if (count < 1 || count > 16 || (references ? track.references : track.descriptions)) return false;
    int at = b.start + 8;
    for (int n = 0; n < count; n++) {
      Box entry = box(at, b.end);
      if (references) {
        if (entry.type != tag("url ") || entry.end - entry.start != 4 || uint(entry.start) != 1) return false;
      } else {
        if (!LOCAL_CODECS.contains(entry.type) || entry.end - entry.start < 8) return false;
        if (entry.type != tag("mp4a")) {
          if (entry.end - entry.start < 78) return false;
          int dimensions = uint(entry.start + 24);
          if (!validDimensions(dimensions >>> 16, dimensions & 0xffff)) return false;
          video = true;
        }
      }
      at = entry.end;
    }
    if (references) track.references = true; else track.descriptions = true;
    return at == b.end;
  }
}
