package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.util.Arrays;

/** Bounded byte-only producer/decoder handoff. No URL, disk staging or seek-driven fetch. */
final class LiveMP3Buffer {
  static final int CAPACITY = 512 * 1024;
  static final int PREFIX = 64 * 1024;
  private final byte[] ring, prefix;
  private final LiveMP3Response.Check check;
  private long produced, consumed;
  private boolean eof, cancelled;
  LiveMP3Buffer(LiveMP3Response.Check check) { this(CAPACITY, PREFIX, check); }
  LiveMP3Buffer(int capacity, int prefixBytes, LiveMP3Response.Check check) {
    if (capacity < 1 || capacity > CAPACITY || prefixBytes < 0 || prefixBytes > PREFIX) throw new IllegalArgumentException();
    ring = new byte[capacity]; prefix = new byte[prefixBytes]; this.check = check;
  }
  private void active() throws IOException { if (cancelled) throw new IOException("Retired live buffer"); check.run(); }
  private void waitBounded() throws IOException {
    active();
    try { wait(25); } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("Interrupted live buffer", error); }
    active();
  }
  synchronized void append(byte[] bytes, int count) throws IOException {
    active();
    if (eof || count < 0 || count > bytes.length || count > 8192) throw new IOException("Invalid live input chunk");
    int offset = 0;
    while (offset < count) {
      while (produced - consumed >= ring.length) waitBounded();
      active();
      int index = (int)(produced % ring.length);
      int size = Math.min(count - offset, Math.min(ring.length - index, ring.length - (int)(produced - consumed)));
      System.arraycopy(bytes, offset, ring, index, size);
      if (produced < prefix.length) System.arraycopy(bytes, offset, prefix, (int)produced, Math.min(size, prefix.length - (int)produced));
      produced += size; offset += size; notifyAll();
    }
  }
  synchronized int read(long position, byte[] output, int offset, int length) throws IOException {
    active();
    if (position < 0 || offset < 0 || length < 0 || offset > output.length - length) throw new IOException("Invalid live decoder read");
    if (length == 0) return 0;
    while (position >= produced && !eof) waitBounded();
    if (position >= produced) return -1;
    long oldest = Math.max(0, produced - ring.length);
    int count = (int)Math.min(Math.min(length, 8192), produced - position);
    if (position < prefix.length) {
      count = Math.min(count, prefix.length - (int)position); System.arraycopy(prefix, (int)position, output, offset, count);
    } else {
      if (position < oldest) throw new IOException("Live source cannot rewind beyond retained prefix");
      int index = (int)(position % ring.length); count = Math.min(count, ring.length - index);
      System.arraycopy(ring, index, output, offset, count);
    }
    consumed = Math.max(consumed, position + count); notifyAll(); return count;
  }
  synchronized void finish() throws IOException { active(); eof = true; notifyAll(); }
  synchronized void cancel() { cancelled = true; Arrays.fill(ring, (byte)0); Arrays.fill(prefix, (byte)0); notifyAll(); }
  synchronized boolean ended() { return eof; }
}
