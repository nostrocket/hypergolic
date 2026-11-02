package org.nostrocket.hypergolic.host;

import java.util.Arrays;

/** Sole native-view owner of claimed bytes, consumed by sequential trusted document reads. */
public final class PublishedArtifactReadOwner {
  public static final int CHUNK_BYTES = 48 * 1024;

  public static final class Chunk {
    public final int sequence, byteLength, totalBytes;
    public final String base64;
    public final boolean done;

    private Chunk(int sequence, int byteLength, int totalBytes, String base64, boolean done) {
      this.sequence = sequence;
      this.byteLength = byteLength;
      this.totalBytes = totalBytes;
      this.base64 = base64;
      this.done = done;
    }
  }

  private byte[] bytes;
  private int nextSequence, offset;

  public PublishedArtifactReadOwner(byte[] bytes) {
    if (bytes == null || bytes.length < 1 || bytes.length > PublishedArtifactRegistry.MAX_HTML_BYTES)
      throw new IllegalArgumentException("Invalid claimed bytes");
    this.bytes = bytes;
  }

  /** Any bad or repeated sequence consumes the remaining bytes. */
  public synchronized Chunk read(int sequence) {
    if (bytes == null) return null;
    if (sequence != nextSequence) { clear(); return null; }
    int length = Math.min(CHUNK_BYTES, bytes.length - offset);
    String base64 = encode(bytes, offset, length);
    int total = bytes.length;
    offset += length;
    nextSequence++;
    boolean done = offset == bytes.length;
    if (done) clear();
    return new Chunk(sequence, length, total, base64, done);
  }

  public synchronized void clear() {
    if (bytes != null) Arrays.fill(bytes, (byte) 0);
    bytes = null;
  }

  private static String encode(byte[] bytes, int offset, int length) {
    char[] alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
    char[] output = new char[((length + 2) / 3) * 4];
    int at = 0;
    int end = offset + length;
    for (int i = offset; i < end; i += 3) {
      int a = bytes[i] & 255;
      int b = i + 1 < end ? bytes[i + 1] & 255 : 0;
      int c = i + 2 < end ? bytes[i + 2] & 255 : 0;
      output[at++] = alphabet[a >>> 2];
      output[at++] = alphabet[((a & 3) << 4) | (b >>> 4)];
      output[at++] = i + 1 < end ? alphabet[((b & 15) << 2) | (c >>> 6)] : '=';
      output[at++] = i + 2 < end ? alphabet[c & 63] : '=';
    }
    return new String(output);
  }
}
