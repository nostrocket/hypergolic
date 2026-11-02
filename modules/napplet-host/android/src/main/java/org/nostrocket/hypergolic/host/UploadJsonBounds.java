package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;

/** Bounds nesting before the platform JSON parser allocates a recursive object graph. */
final class UploadJsonBounds {
  private UploadJsonBounds() {}
  static boolean accepts(String input, int maximumBytes) {
    return accepts(input, maximumBytes, 12);
  }
  static boolean accepts(String input, int maximumBytes, int maximumDepth) {
    if (maximumDepth < 1 || maximumDepth > 40) return false;
    if (input == null || input.length() > maximumBytes || input.getBytes(StandardCharsets.UTF_8).length > maximumBytes) return false;
    int depth = 0; boolean quoted = false, escaped = false;
    for (int index = 0; index < input.length(); index++) {
      char value = input.charAt(index);
      if (quoted) {
        if (escaped) escaped = false;
        else if (value == '\\') escaped = true;
        else if (value == '"') quoted = false;
      } else if (value == '"') quoted = true;
      else if (value == '[' || value == '{') { if (++depth > maximumDepth) return false; }
      else if (value == ']' || value == '}') { if (--depth < 0) return false; }
    }
    return depth == 0 && !quoted;
  }
}
