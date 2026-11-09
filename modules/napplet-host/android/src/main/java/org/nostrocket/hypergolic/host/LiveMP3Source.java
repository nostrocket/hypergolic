package org.nostrocket.hypergolic.host;

import android.media.MediaDataSource;
import java.io.IOException;

/** MediaPlayer receives app-owned bytes only; it has no publisher URL or network fallback. */
final class LiveMP3Source extends MediaDataSource {
  private final LiveMP3Buffer bytes;
  LiveMP3Source(LiveMP3Buffer bytes) { this.bytes = bytes; }
  @Override public int readAt(long position, byte[] output, int offset, int size) throws IOException {
    return bytes.read(position, output, offset, size);
  }
  @Override public long getSize() { return -1; }
  @Override public void close() { bytes.cancel(); }
}
