package org.nostrocket.hypergolic.host;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** One explicitly authorized, strictly framed response written to the owner's private file. */
final class MediaHttpsFile {
  static final int MAX_BYTES = 256 * 1024 * 1024;
  static final int TOTAL_MS = 300_000;
  static final int IDLE_MS = 10_000;
  private static final int HEADROOM_BYTES = 128 * 1024 * 1024;
  private static final int BUFFER_BYTES = 64 * 1024;
  interface Check { void run() throws IOException; }
  interface Progress { void update(int received, int total); }

  private MediaHttpsFile() {}

  static File download(String url, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.Cancellation cancellation, PublishedHttpsTransport.Deadline deadline,
      File destination, Progress progress) throws IOException {
    return PublishedHttpsTransport.getMedia(url, policy, cancellation, deadline, IDLE_MS, (input, abort) -> {
      readResponse(input, destination, abort::check, progress);
      return destination;
    });
  }

  static void readResponse(InputStream input, File destination, Check check, Progress progress) throws IOException {
    int length = PublishedHttpsResponseReader.readMediaLength(input, MAX_BYTES);
    copy(input, length, destination, check, progress);
  }

  static void copy(InputStream input, int length, File destination, Check check, Progress progress) throws IOException {
    if (length < 1 || length > MAX_BYTES) throw new IOException("Invalid Media body length");
    check.run();
    File parent = destination.getParentFile();
    if (parent == null || parent.getUsableSpace() < (long)length + HEADROOM_BYTES) {
      throw new IOException("Insufficient Media disk space");
    }
    // The caller owns the app-private directory and serializes all writers.
    if (!destination.createNewFile()) throw new IOException("Media file already exists");
    boolean complete = false;
    try {
      try (var output = new FileOutputStream(destination)) {
        byte[] buffer = new byte[BUFFER_BYTES];
        int written = 0;
        progress.update(0, length);
        while (written < length) {
          check.run();
          int count = input.read(buffer, 0, Math.min(buffer.length, length - written));
          if (count <= 0) throw new IOException("Truncated Media body");
          check.run();
          output.write(buffer, 0, count);
          written += count;
          progress.update(written, length);
        }
        check.run();
        if (input.read() != -1) throw new IOException("Trailing Media response bytes");
      }
      check.run();
      complete = true;
    } finally {
      if (!complete && !destination.delete() && destination.exists()) throw new IOException("Media cleanup failed");
    }
  }
}
