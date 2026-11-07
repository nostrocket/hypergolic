package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Deliberately separate from finite Media framing. No cookies, auth challenges or ICY interleaving. */
final class LiveMP3Headers {
  static final int MAX_HEAD = 32 * 1024;
  static final int MAX_TRAILERS = 8192;
  private LiveMP3Headers() {}
  static String line(InputStream input, int maximum) throws IOException {
    byte[] bytes = new byte[maximum]; int count = 0;
    while (true) {
      int value = input.read();
      if (value < 0) throw new IOException("Truncated live response line");
      if (value == '\r') {
        if (input.read() != '\n') throw new IOException("Invalid live CRLF");
        return new String(bytes, 0, count, StandardCharsets.US_ASCII);
      }
      if (value < 32 && value != '\t' || value > 126) throw new IOException("Invalid live response character");
      if (count >= maximum) throw new IOException("Live response line limit");
      bytes[count++] = (byte)value;
    }
  }
  static Map<String, String> fields(InputStream input, int maximum, int lines) throws IOException {
    Map<String, String> result = new LinkedHashMap<>(); int total = 0;
    for (int n = 0; n <= lines; n++) {
      String line = line(input, Math.min(8192, maximum - total));
      total += line.length() + 2;
      if (total > maximum) throw new IOException("Live response head limit");
      if (line.isEmpty()) return result;
      if (n == lines) throw new IOException("Live header count limit");
      int colon = line.indexOf(':');
      if (colon < 1 || !line.substring(0, colon).matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw new IOException("Invalid live header name");
      String key = line.substring(0, colon).toLowerCase(Locale.ROOT);
      if (result.putIfAbsent(key, line.substring(colon + 1).trim()) != null) throw new IOException("Duplicate live header");
    }
    throw new IOException("Live header count limit");
  }
  static long length(String raw) throws IOException {
    if (raw == null || !raw.matches("[0-9]{1,10}")) throw new IOException("Invalid live content length");
    long value = Long.parseLong(raw);
    if (value > LiveMP3Budget.MAX_BYTES) throw new IOException("Live content length limit");
    return value;
  }
  static void trailers(InputStream input) throws IOException {
    Map<String, String> trailer = fields(input, MAX_TRAILERS, 32);
    for (String key : trailer.keySet()) {
      if (key.equals("content-length") || key.equals("transfer-encoding") || key.equals("content-encoding") ||
          key.equals("content-type") || key.equals("location") || key.startsWith("icy-")) throw new IOException("Forbidden live trailer");
    }
  }
}
