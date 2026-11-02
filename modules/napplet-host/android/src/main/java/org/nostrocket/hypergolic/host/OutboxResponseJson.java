package org.nostrocket.hypergolic.host;

/** Validate relay-array JSON syntax before Android's deliberately lenient object parser. */
final class OutboxResponseJson {
  private static final char OBJECT_OPEN = '{';
  private static final char OBJECT_CLOSE = '}';
  private final String input;
  private int position;
  private OutboxResponseJson(String input) { this.input = input; }

  static boolean accepts(String input) {
    if (!UploadJsonBounds.accepts(input, 2 * 1024 * 1024)) return false;
    OutboxResponseJson parser = new OutboxResponseJson(input);
    parser.space();
    if (!parser.take('[') || !parser.sequence(1, false)) return false;
    parser.space();
    return parser.position == input.length();
  }

  private boolean value(int depth) {
    space();
    if (position == input.length()) return false;
    char token = input.charAt(position);
    if (token == '"') return string();
    if (token == '[' || token == OBJECT_OPEN) {
      if (depth >= 12) return false;
      position++;
      return sequence(depth + 1, token == OBJECT_OPEN);
    }
    if (token == 't') return literal("true");
    if (token == 'f') return literal("false");
    if (token == 'n') return literal("null");
    return number();
  }

  private boolean sequence(int depth, boolean object) {
    char end = object ? OBJECT_CLOSE : ']';
    space();
    if (take(end)) return true;
    do {
      space();
      if (object) {
        if (!string()) return false;
        space();
        if (!take(':')) return false;
      }
      if (!value(depth)) return false;
      space();
      if (take(end)) return true;
      if (!take(',')) return false;
    } while (position < input.length());
    return false;
  }

  private boolean string() {
    if (!take('"')) return false;
    while (position < input.length()) {
      char token = input.charAt(position++);
      if (token == '"') return true;
      if (token < 0x20) return false;
      if (token != '\\') continue;
      if (position == input.length()) return false;
      char escape = input.charAt(position++);
      if (escape == 'u') {
        for (int count = 0; count < 4; count++) {
          if (position == input.length()) return false;
          char hex = input.charAt(position++);
          if (!(hex >= '0' && hex <= '9' || hex >= 'a' && hex <= 'f' || hex >= 'A' && hex <= 'F')) return false;
        }
      } else if ("\"\\/bfnrt".indexOf(escape) < 0) return false;
    }
    return false;
  }

  private boolean number() {
    take('-');
    if (!take('0') && !digits()) return false;
    if (take('.') && !digits()) return false;
    if (take('e') || take('E')) {
      if (!take('+')) take('-');
      if (!digits()) return false;
    }
    return true;
  }

  private boolean digits() {
    int start = position;
    while (position < input.length() && input.charAt(position) >= '0' && input.charAt(position) <= '9') position++;
    return position > start;
  }
  private boolean literal(String value) {
    if (!input.startsWith(value, position)) return false;
    position += value.length();
    return true;
  }
  private boolean take(char value) {
    if (position == input.length() || input.charAt(position) != value) return false;
    position++;
    return true;
  }
  private void space() {
    while (position < input.length()) {
      char value = input.charAt(position);
      if (value != ' ' && value != '\t' && value != '\n' && value != '\r') return;
      position++;
    }
  }
}
