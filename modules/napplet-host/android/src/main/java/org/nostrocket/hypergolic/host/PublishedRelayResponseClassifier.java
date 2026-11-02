package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.TextKind;
import org.nostrocket.hypergolic.host.PublishedRelayWssQuery.TextStopPolicy;

/** Strict bounded NIP-01 response envelope classifier for one active subscription. */
public final class PublishedRelayResponseClassifier implements PublishedRelayWssQuery.TextStopPolicy {
  private static final int MAX_TEXT_BYTES = PublishedRelayWebSocketFrames.MAX_BYTES;
  private static final int MAX_NOTICE_BYTES = 256;
  private static final int MAX_DEPTH = 32;
  private final String subscriptionId;

  public PublishedRelayResponseClassifier(String subscriptionId) {
    if (subscriptionId == null || !subscriptionId.matches("[A-Za-z0-9_-]{1,64}")) {
      throw new IllegalArgumentException("Invalid relay subscription id");
    }
    this.subscriptionId = subscriptionId;
  }

  /** Rejects a mismatched or malformed outbound REQ before a socket is opened. */
  public static void validateRequest(String text, String subscriptionId) throws IOException {
    if (text == null || text.length() > PublishedRelayWebSocketClientFrames.MAX_TEXT_BYTES ||
        text.getBytes(StandardCharsets.UTF_8).length > PublishedRelayWebSocketClientFrames.MAX_TEXT_BYTES ||
        subscriptionId == null || !subscriptionId.matches("[A-Za-z0-9_-]{1,64}")) throw invalid();
    Parser parser = new Parser(text);
    parser.expect('[');
    if (!"REQ".equals(parser.string())) throw invalid();
    parser.expect(',');
    if (!subscriptionId.equals(parser.string())) throw invalid();
    parser.expect(',');
    if (parser.value(0) != Value.OBJECT) throw invalid();
    while (parser.nextIs(',')) {
      parser.expect(',');
      if (parser.value(0) != Value.OBJECT) throw invalid();
    }
    parser.expect(']');
    parser.end();
  }

  @Override public PublishedRelayWssQuery.TextKind classify(String text) throws IOException {
    if (text == null || text.length() > MAX_TEXT_BYTES || text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) throw invalid();
    Parser parser = new Parser(text);
    parser.expect('[');
    String kind = parser.string();
    parser.expect(',');
    switch (kind) {
      case "EVENT":
        requireSubscription(parser.string());
        parser.expect(',');
        if (parser.value(0) != Value.OBJECT) throw invalid();
        parser.expect(']');
        parser.end();
        return PublishedRelayWssQuery.TextKind.EVENT;
      case "EOSE":
        requireSubscription(parser.string());
        parser.expect(']');
        parser.end();
        return PublishedRelayWssQuery.TextKind.EOSE;
      case "NOTICE":
        String notice = parser.string();
        parser.expect(']');
        parser.end();
        if (notice.length() > MAX_NOTICE_BYTES || notice.getBytes(StandardCharsets.UTF_8).length > MAX_NOTICE_BYTES) throw invalid();
        return PublishedRelayWssQuery.TextKind.OTHER;
      case "AUTH":
        // Optional NIP-42 announcement; existing frame/count budgets remain.
        // Consume only an exact string challenge; never store or answer it.
        parser.string();
        parser.expect(']');
        parser.end();
        return PublishedRelayWssQuery.TextKind.OTHER;
      case "CLOSED":
        requireSubscription(parser.string());
        parser.expect(',');
        parser.string();
        parser.expect(']');
        parser.end();
        throw new IOException("Relay closed the active subscription");
      default:
        throw invalid();
    }
  }

  private void requireSubscription(String value) throws IOException {
    if (!subscriptionId.equals(value)) throw invalid();
  }
  private static IOException invalid() { return new IOException("Invalid relay response envelope"); }
  private enum Value { OBJECT, ARRAY, STRING, OTHER }

  private static final class Parser {
    private final String source;
    private int offset;
    Parser(String source) { this.source = source; }

    String string() throws IOException {
      whitespace();
      if (take() != '"') throw invalid();
      StringBuilder result = new StringBuilder();
      while (offset < source.length()) {
        char c = take();
        if (c == '"') return result.toString();
        if (c < 0x20) throw invalid();
        if (c == '\\') {
          char escaped = take();
          switch (escaped) {
            case '"': case '\\': case '/': result.append(escaped); break;
            case 'b': result.append('\b'); break;
            case 'f': result.append('\f'); break;
            case 'n': result.append('\n'); break;
            case 'r': result.append('\r'); break;
            case 't': result.append('\t'); break;
            case 'u': result.append(unicodeEscape()); break;
            default: throw invalid();
          }
        } else {
          if (Character.isHighSurrogate(c)) {
            if (offset >= source.length() || !Character.isLowSurrogate(source.charAt(offset))) throw invalid();
            result.append(c).append(take());
          } else if (Character.isLowSurrogate(c)) throw invalid();
          else result.append(c);
        }
      }
      throw invalid();
    }

    Value value(int depth) throws IOException {
      if (depth > MAX_DEPTH) throw invalid();
      whitespace();
      char c = peek();
      if (c == '"') { string(); return Value.STRING; }
      if (c == '{') { object(depth + 1); return Value.OBJECT; }
      if (c == '[') { array(depth + 1); return Value.ARRAY; }
      literal("true");
      if (c == 't') return Value.OTHER;
      literal("false");
      if (c == 'f') return Value.OTHER;
      literal("null");
      if (c == 'n') return Value.OTHER;
      number();
      return Value.OTHER;
    }

    private void object(int depth) throws IOException {
      expect('{'); whitespace();
      if (peek() == '}') { take(); return; }
      while (true) {
        string(); expect(':'); value(depth); whitespace();
        char delimiter = take();
        if (delimiter == '}') return;
        if (delimiter != ',') throw invalid();
      }
    }

    private void array(int depth) throws IOException {
      expect('['); whitespace();
      if (peek() == ']') { take(); return; }
      while (true) {
        value(depth); whitespace();
        char delimiter = take();
        if (delimiter == ']') return;
        if (delimiter != ',') throw invalid();
      }
    }

    private void number() throws IOException {
      int start = offset;
      if (peek() == '-') take();
      if (peek() == '0') {
        take();
        if (isDigit(peek())) throw invalid();
      } else {
        if (!isOneToNine(peek())) throw invalid();
        while (isDigit(peek())) take();
      }
      if (peek() == '.') {
        take();
        if (!isDigit(peek())) throw invalid();
        while (isDigit(peek())) take();
      }
      if (peek() == 'e' || peek() == 'E') {
        take();
        if (peek() == '+' || peek() == '-') take();
        if (!isDigit(peek())) throw invalid();
        while (isDigit(peek())) take();
      }
      if (offset == start) throw invalid();
    }

    private String unicodeEscape() throws IOException {
      if (offset + 4 > source.length()) throw invalid();
      int value = 0;
      for (int i = 0; i < 4; i++) {
        int digit = hexDigit(take());
        if (digit < 0) throw invalid();
        value = (value << 4) | digit;
      }
      char decoded = (char) value;
      if (Character.isHighSurrogate(decoded)) {
        if (offset + 6 > source.length() || source.charAt(offset) != '\\' || source.charAt(offset + 1) != 'u') throw invalid();
        take(); take();
        int low = 0;
        for (int i = 0; i < 4; i++) {
          int digit = hexDigit(take());
          if (digit < 0) throw invalid();
          low = (low << 4) | digit;
        }
        if (!Character.isLowSurrogate((char) low)) throw invalid();
        return new String(new char[] {decoded, (char) low});
      }
      if (Character.isLowSurrogate(decoded)) throw invalid();
      return String.valueOf(decoded);
    }

    void expect(char expected) throws IOException { whitespace(); if (take() != expected) throw invalid(); }
    boolean nextIs(char value) throws IOException { whitespace(); return peek() == value; }
    void end() throws IOException { whitespace(); if (offset != source.length()) throw invalid(); }
    private void literal(String value) throws IOException {
      if (offset < source.length() && source.charAt(offset) == value.charAt(0)) {
        if (!source.startsWith(value, offset)) throw invalid();
        offset += value.length();
      }
    }
    private void whitespace() { while (offset < source.length() && " \t\r\n".indexOf(source.charAt(offset)) >= 0) offset++; }
    private char peek() throws IOException { if (offset >= source.length()) throw invalid(); return source.charAt(offset); }
    private char take() throws IOException { if (offset >= source.length()) throw invalid(); return source.charAt(offset++); }
    private static boolean isDigit(char c) { return c >= '0' && c <= '9'; }
    private static boolean isOneToNine(char c) { return c >= '1' && c <= '9'; }
    private static int hexDigit(char c) {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    }
  }

  static final class ResponseCollector {
    private final TextStopPolicy stopPolicy;
    private final ArrayList<String> messages = new ArrayList<>();
    private int totalBytes;
    private int eventCount;
    private boolean complete;
    ResponseCollector(TextStopPolicy stopPolicy) { this.stopPolicy = stopPolicy; }
    void preflight(List<PublishedRelayWebSocketFrames.Event> batch) throws IOException {
      int textCount = 0;
      int textBytes = 0;
      for (PublishedRelayWebSocketFrames.Event event : batch) {
        if ("error".equals(event.type)) throw new IOException("Invalid relay WebSocket frame: " + event.detail);
        if ("text".equals(event.type)) {
          textCount++;
          textBytes += event.text.getBytes(StandardCharsets.UTF_8).length;
        }
      }
      if (textCount > PublishedRelayWssQuery.MAX_TEXT_MESSAGES - messages.size() || textBytes > PublishedRelayWssQuery.MAX_TEXT_BYTES - totalBytes) {
        throw new IOException("Relay query exceeded response bounds");
      }
    }
    boolean accept(String text) throws IOException {
      if (complete || text == null || messages.size() >= PublishedRelayWssQuery.MAX_TEXT_MESSAGES) {
        throw new IOException("Relay query exceeded response bounds");
      }
      int length = text.getBytes(StandardCharsets.UTF_8).length;
      if (length > PublishedRelayWebSocketFrames.MAX_BYTES || length > PublishedRelayWssQuery.MAX_TEXT_BYTES - totalBytes) {
        throw new IOException("Relay query exceeded response bounds");
      }
      totalBytes += length;
      messages.add(text);
      final TextKind kind;
      try { kind = stopPolicy.classify(text); }
      catch (RuntimeException invalid) { throw new IOException("Relay text validation failed", invalid); }
      if (kind == null) throw new IOException("Relay text validation failed");
      if (kind == TextKind.EVENT && ++eventCount > PublishedRelayWssQuery.MAX_EVENTS) throw new IOException("Relay query exceeded event limit");
      complete = kind == TextKind.EOSE;
      return complete;
    }
    boolean complete() { return complete; }
    List<String> result() { return Collections.unmodifiableList(new ArrayList<>(messages)); }
  }
}
