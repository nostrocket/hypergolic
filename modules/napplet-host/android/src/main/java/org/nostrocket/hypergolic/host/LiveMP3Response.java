package org.nostrocket.hypergolic.host;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;

/** Incremental HTTP/1.x audio/mpeg response decoder. Output receives only payload, never framing. */
final class LiveMP3Response {
  interface Sink { void append(byte[] bytes, int count) throws IOException; }
  interface Check { void run() throws IOException; }
  private LiveMP3Response() {}
  static void read(InputStream source, LiveMP3Budget budget, Check active, Sink output) throws IOException {
    InputStream input = new FilterInputStream(source) {
      @Override public int read() throws IOException {
        active.run(); budget.check(); int value = in.read();
        active.run(); if (value >= 0) budget.charge(1); return value;
      }
      @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        active.run(); budget.check(); int count = in.read(bytes, offset, Math.min(length, budget.readAllowance()));
        active.run(); if (count > 0) budget.charge(count); return count;
      }
    };
    String status = LiveMP3Headers.line(input, 128);
    if (!status.matches("HTTP/1\\.[01] [0-9]{3}( [ -~]*)?")) throw new IOException("Invalid live HTTP status");
    Map<String, String> head = LiveMP3Headers.fields(input, LiveMP3Headers.MAX_HEAD - status.length() - 2, 128);
    int code = Integer.parseInt(status.substring(9, 12));
    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
      String location = head.get("location");
      if (location == null || location.isEmpty() || location.length() > 8192) throw new IOException("Invalid live redirect");
      throw new PublishedHttpsResponseReader.ResourceRedirect(location);
    }
    if (code != 200 || head.containsKey("location") || head.containsKey("content-range") ||
        !head.getOrDefault("content-encoding", "identity").equalsIgnoreCase("identity") ||
        !head.getOrDefault("icy-metaint", "0").equals("0") ||
        !head.getOrDefault("content-type", "").split(";", 2)[0].trim().equalsIgnoreCase("audio/mpeg")) {
      throw new IOException("Unsupported live MP3 response");
    }
    String transfer = head.get("transfer-encoding"), length = head.get("content-length");
    if (transfer != null && length != null) throw new IOException("Ambiguous live framing");
    if (transfer != null) {
      if (!transfer.equalsIgnoreCase("chunked")) throw new IOException("Unsupported live transfer encoding");
      chunked(input, active, output);
    } else if (length != null) exact(input, LiveMP3Headers.length(length), active, output);
    else untilEOF(input, active, output);
    active.run(); budget.check();
    if (input.read() != -1) throw new IOException("Trailing live response bytes");
  }
  private static void exact(InputStream input, long remaining, Check active, Sink output) throws IOException {
    byte[] buffer = new byte[8192];
    while (remaining > 0) {
      active.run(); int count = input.read(buffer, 0, (int)Math.min(buffer.length, remaining));
      if (count <= 0) throw new IOException("Truncated live payload");
      active.run(); output.append(buffer, count); remaining -= count;
    }
  }
  private static void untilEOF(InputStream input, Check active, Sink output) throws IOException {
    byte[] buffer = new byte[8192]; int count;
    while ((count = input.read(buffer)) != -1) {
      if (count <= 0) throw new IOException("Empty live payload read");
      active.run(); output.append(buffer, count);
    }
  }
  private static void chunked(InputStream input, Check active, Sink output) throws IOException {
    for (;;) {
      String line = LiveMP3Headers.line(input, 128);
      // The initial selected profile rejects extensions rather than interpreting new metadata.
      if (!line.matches("[0-9a-fA-F]{1,8}")) throw new IOException("Unsupported live chunk line");
      long count = Long.parseLong(line, 16);
      if (count > LiveMP3Budget.MAX_BYTES) throw new IOException("Live chunk size limit");
      if (count == 0) { LiveMP3Headers.trailers(input); return; }
      exact(input, count, active, output);
      if (input.read() != '\r' || input.read() != '\n') throw new IOException("Invalid live chunk boundary");
    }
  }
}
