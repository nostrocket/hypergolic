package org.nostrocket.hypergolic.host;

import java.util.List;

/** Conservative IP-literal policy for a future pinned native transport. This does not pin DNS. */
public final class PublicAddressPolicy {
  private PublicAddressPolicy() {}

  /** Classifies an address already resolved by a transport, without any name lookup. */
  public static boolean accepts(byte[] address) {
    if (address == null) return false;
    if (address.length == 4) return publicV4(address);
    if (address.length == 16) return publicV6(address);
    return false;
  }

  /** True only for syntactically valid, globally routable unicast address literals. */
  public static boolean isPublicLiteral(String value) {
    if (value == null || value.isEmpty() || value.indexOf('%') >= 0 || value.indexOf('[') >= 0 || value.indexOf(']') >= 0) return false;
    if (value.indexOf(':') >= 0) {
      byte[] address = parseV6(value);
      return address != null && publicV6(address);
    }
    byte[] address = parseV4(value);
    return address != null && publicV4(address);
  }

  /** Reject the whole DNS result set if it is empty, malformed, or contains any non-public answer. */
  public static boolean allPublicAnswers(List<String> answers) {
    if (answers == null || answers.isEmpty()) return false;
    for (String answer : answers) if (!isPublicLiteral(answer)) return false;
    return true;
  }

  private static byte[] parseV4(String input) {
    String[] parts = input.split("\\.", -1);
    if (parts.length != 4) return null;
    byte[] out = new byte[4];
    for (int i = 0; i < 4; i++) {
      String part = parts[i];
      if (part.isEmpty() || part.length() > 3 || (part.length() > 1 && part.charAt(0) == '0')) return null;
      int n = 0;
      for (int j = 0; j < part.length(); j++) {
        char c = part.charAt(j);
        if (c < '0' || c > '9') return null;
        n = n * 10 + c - '0';
      }
      if (n > 255) return null;
      out[i] = (byte) n;
    }
    return out;
  }

  private static byte[] parseV6(String input) {
    if (input.indexOf("::") != input.lastIndexOf("::")) return null;
    String text = input;
    int dot = text.indexOf('.');
    if (dot >= 0) {
      int colon = text.lastIndexOf(':');
      if (colon < 0) return null;
      byte[] v4 = parseV4(text.substring(colon + 1));
      if (v4 == null) return null;
      int first = ((v4[0] & 0xff) << 8) | (v4[1] & 0xff);
      int second = ((v4[2] & 0xff) << 8) | (v4[3] & 0xff);
      text = text.substring(0, colon + 1) + Integer.toHexString(first) + ":" + Integer.toHexString(second);
    }
    boolean compressed = text.contains("::");
    String[] halves = text.split("::", -1);
    String[] left = halves[0].isEmpty() ? new String[0] : halves[0].split(":", -1);
    String[] right = halves.length == 1 || halves[1].isEmpty() ? new String[0] : halves[1].split(":", -1);
    int count = left.length + right.length;
    if ((compressed && count >= 8) || (!compressed && count != 8)) return null;
    int zeros = compressed ? 8 - count : 0;
    byte[] out = new byte[16];
    int index = 0;
    for (String group : left) { if (!putGroup(group, out, index++)) return null; }
    index += zeros;
    for (String group : right) { if (!putGroup(group, out, index++)) return null; }
    return index == 8 ? out : null;
  }

  private static boolean putGroup(String group, byte[] out, int index) {
    if (group.isEmpty() || group.length() > 4 || index < 0 || index > 7) return false;
    int n = 0;
    for (int i = 0; i < group.length(); i++) {
      int d = Character.digit(group.charAt(i), 16);
      if (d < 0 || group.charAt(i) > 127) return false;
      n = (n << 4) | d;
    }
    out[index * 2] = (byte) (n >>> 8);
    out[index * 2 + 1] = (byte) n;
    return true;
  }

  private static boolean publicV4(byte[] a) {
    return !(prefix(a, 0, 8) || prefix(a, 10, 8) || prefix2(a, 100, 64, 10) || prefix(a, 127, 8) ||
        prefix2(a, 169, 254, 16) || prefix2(a, 172, 16, 12) || prefix3(a, 192, 0, 0) ||
        prefix3(a, 192, 0, 2) || prefix3(a, 192, 88, 99) || prefix2(a, 192, 168, 16) ||
        prefix2(a, 198, 18, 15) || prefix3(a, 198, 51, 100) || prefix3(a, 203, 0, 113) ||
        prefix(a, 224, 4) || prefix(a, 240, 4));
  }

  private static boolean publicV6(byte[] a) {
    // Only 2000::/3 global-unicast space is considered. This excludes unspecified,
    // loopback, ULA, link-local, multicast, NAT64, IPv4-compatible and most special use.
    if ((a[0] & 0xe0) != 0x20) return false;
    if ((a[0] & 0xff) == 0x20 && (a[1] & 0xff) == 0x01 && (a[2] & 0xff) <= 0x01) return false; // 2001::/23
    if ((a[0] & 0xff) == 0x20 && (a[1] & 0xff) == 0x01 && (a[2] & 0xff) == 0x0d && (a[3] & 0xff) == 0xb8) return false; // documentation
    if ((a[0] & 0xff) == 0x20 && (a[1] & 0xff) == 0x02) return false; // 6to4
    if ((a[0] & 0xff) == 0x3f && (a[1] & 0xff) == 0xff && (a[2] & 0xf0) == 0) return false; // 3fff::/20 documentation
    // IPv4-mapped forms are rejected even when the embedded IPv4 address is public.
    for (int i = 0; i < 10; i++) if (a[i] != 0) return true;
    return a[10] != (byte) 0xff || a[11] != (byte) 0xff;
  }

  private static boolean prefix(byte[] a, int first, int bits) {
    int mask = (0xff << (8 - bits)) & 0xff;
    return (a[0] & mask) == (first & mask);
  }
  private static boolean prefix2(byte[] a, int x, int y, int bits) {
    int value = ((a[0] & 0xff) << 8) | (a[1] & 0xff);
    return value >>> (16 - bits) == ((x << 8) | y) >>> (16 - bits);
  }
  private static boolean prefix3(byte[] a, int x, int y, int z) {
    return (a[0] & 0xff) == x && (a[1] & 0xff) == y && (a[2] & 0xff) == z;
  }
}
