package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Locale;

/** Strict RFC 6455 server-upgrade response validator. Input must contain headers only. */
public final class PublishedRelayWebSocketHandshake {
  public static final int MAX_HEADER_BYTES = 16_384;
  private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  private PublishedRelayWebSocketHandshake() {}

  public static void validate(byte[] response, byte[] nonce) {
    if (response == null || nonce == null || nonce.length != 16) fail();
    if (response.length == 0 || response.length > MAX_HEADER_BYTES) fail();
    String raw = ascii(response);
    int end = raw.indexOf("\r\n\r\n");
    if (end < 0 || end + 4 != raw.length()) fail(); // Reject bodies and prefetched frame bytes.
    String[] lines = raw.substring(0, end).split("\r\n", -1);
    if (lines.length < 2 || !lines[0].matches("HTTP/1\\.1 101(?: [\\x20-\\x7e]*)?")) fail();
    String upgrade = null, connection = null, accept = null;
    for (int i = 1; i < lines.length; i++) {
      String line = lines[i];
      int colon = line.indexOf(':');
      if (colon <= 0 || line.charAt(0) == ' ' || line.charAt(0) == '\t') fail();
      String name = line.substring(0, colon);
      if (!name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) fail();
      String key = name.toLowerCase(Locale.ROOT);
      String value = trimOws(line.substring(colon + 1));
      if (hasForbiddenControls(value)) fail();
      switch (key) {
        case "upgrade": if (upgrade != null) fail(); upgrade = value; break;
        case "connection": if (connection != null) fail(); connection = value; break;
        case "sec-websocket-accept": if (accept != null) fail(); accept = value; break;
        case "sec-websocket-extensions": case "sec-websocket-protocol": case "location":
        case "content-length": case "transfer-encoding": fail(); break;
        // Unconsumed metadata may repeat (for example Server-Timing or Set-Cookie).
        default: break;
      }
    }
    if (!hasToken(upgrade, "websocket") || !hasToken(connection, "upgrade")) fail();
    String key = Base64.getEncoder().encodeToString(nonce) + GUID;
    String expected;
    try {
      expected = Base64.getEncoder().encodeToString(
          MessageDigest.getInstance("SHA-1").digest(key.getBytes(StandardCharsets.US_ASCII)));
    } catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    if (accept == null || !MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.US_ASCII), accept.getBytes(StandardCharsets.US_ASCII))) fail();
  }

  private static String ascii(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length);
    for (byte b : bytes) {
      int c = b & 0xff;
      if (c < 0x20 && c != '\r' && c != '\n' && c != '\t' || c > 0x7e) fail();
      out.append((char) c);
    }
    return out.toString();
  }
  private static boolean hasForbiddenControls(String value) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c < 0x20 && c != '\t' || c == 0x7f) return true;
    }
    return false;
  }
  private static String trimOws(String value) {
    int start = 0, end = value.length();
    while (start < end && (value.charAt(start) == ' ' || value.charAt(start) == '\t')) start++;
    while (end > start && (value.charAt(end - 1) == ' ' || value.charAt(end - 1) == '\t')) end--;
    return value.substring(start, end);
  }
  private static boolean hasToken(String value, String token) {
    if (value == null) return false;
    for (String part : value.split(",", -1)) if (trimOws(part).equalsIgnoreCase(token)) return true;
    return false;
  }
  private static void fail() { throw new IllegalArgumentException("Invalid WebSocket upgrade response"); }
}
