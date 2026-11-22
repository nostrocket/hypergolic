package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Sole native-view owner of claimed bytes, consumed by sequential trusted document reads. */
public final class PublishedArtifactReadOwner {
  public static final int CHUNK_BYTES = 256 * 1024;

  public static final class Chunk {
    public final int sequence, byteLength, totalBytes;
    public final String text;
    public final boolean done;

    private Chunk(int sequence, int byteLength, int totalBytes, String text, boolean done) {
      this.sequence = sequence;
      this.byteLength = byteLength;
      this.totalBytes = totalBytes;
      this.text = text;
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
    int end = Math.min(offset + CHUNK_BYTES, bytes.length);
    // The registry already checked UTF-8. End the IPC string on a scalar boundary.
    while (end < bytes.length && (bytes[end] & 0xc0) == 0x80) end--;
    int length = end - offset;
    String text = new String(bytes, offset, length, StandardCharsets.UTF_8);
    int total = bytes.length;
    offset += length;
    nextSequence++;
    boolean done = offset == bytes.length;
    if (done) clear();
    return new Chunk(sequence, length, total, text, done);
  }

  public synchronized void clear() {
    if (bytes != null) Arrays.fill(bytes, (byte) 0);
    bytes = null;
  }

}
