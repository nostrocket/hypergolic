package org.nostrocket.hypergolic.host;
import java.net.URI;
/** Conservative absolute ASCII URI profile. No DNS, fetch or normalization. */
public final class LinkUrl {
  /** Show identity controls literally so signed identifiers cannot create extra review fields. */
  public static String displayIdentity(String value) {
    StringBuilder out = new StringBuilder();
    for (char c : value.toCharArray()) {
      if (c < 32 || c >= 127 && c <= 159 || c == 0x061c || c == 0x200e || c == 0x200f ||
          c >= 0x2028 && c <= 0x202e || c >= 0x2066 && c <= 0x2069) out.append(String.format(java.util.Locale.ROOT, "\\u%04X", (int)c));
      else out.append(c);
    }
    return out.toString();
  }
  public static String error(String raw) {
    if (raw == null || raw.isEmpty() || raw.length() > 4096) return "invalid-url";
    for (char c : raw.toCharArray()) if (c < 33 || c > 126 || c == '\\') return "invalid-url";
    try {
      URI u = new URI(raw);
      if (!u.isAbsolute()) return "invalid-url";
      if (!"https".equalsIgnoreCase(u.getScheme())) return "unsupported-scheme";
      String host = u.getHost();
      if (u.getRawAuthority() == null || !u.getRawAuthority().matches("(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:.]+\\])(?::[0-9]{1,5})?")) return "invalid-url";
      if (u.isOpaque() || host == null || host.isEmpty() || u.getRawUserInfo() != null || u.getPort() == 0 || u.getPort() > 65535) return "invalid-url";
      if (host.length() > 253 || host.endsWith(".") || host.contains("%")) return "invalid-url";
      if (host.startsWith("[")) return null;
      for (String label : host.split("\\.", -1)) if (!label.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")) return "invalid-url";
      if (host.matches("[0-9.]+")) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return "invalid-url";
        for (String part : parts) if (part.length() > 3 || part.length() > 1 && part.startsWith("0") || Integer.parseInt(part) > 255) return "invalid-url";
      }
      return null;
    } catch (Exception e) { return "invalid-url"; }
  }
}
