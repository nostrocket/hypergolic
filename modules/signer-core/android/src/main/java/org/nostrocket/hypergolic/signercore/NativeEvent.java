package org.nostrocket.hypergolic.signercore;

import android.util.JsonReader;
import android.util.JsonToken;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/** Strict NIP-01 capture. Android's general JSONObject parser is intentionally not used. */
final class NativeEvent {
  static final int MAX_BYTES = 2 * 1024 * 1024;
  final String pubkey, content, tags, unsigned, canonical;
  final long createdAt;
  final int kind;
  final byte[] digest;

  private NativeEvent(String pubkey, long createdAt, int kind, String tags, String content, int maximum) throws Exception {
    this.pubkey = pubkey; this.createdAt = createdAt; this.kind = kind; this.tags = tags; this.content = content;
    canonical = "[0," + quote(pubkey) + "," + createdAt + "," + kind + "," + tags + "," + quote(content) + "]";
    unsigned = "{\"pubkey\":" + quote(pubkey) + ",\"created_at\":" + createdAt + ",\"kind\":" + kind + ",\"tags\":" + tags + ",\"content\":" + quote(content) + "}";
    if (canonical.getBytes(StandardCharsets.UTF_8).length > maximum) throw new NativeSignerCore.Denied();
    digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8));
  }
  static NativeEvent capture(String raw, String expectedPubkey) { return capture(raw, expectedPubkey, MAX_BYTES); }
  static NativeEvent capture(String raw, String expectedPubkey, int maximum) {
    try {
      if (raw == null || maximum < 1 || maximum > 8 * 1024 * 1024 || raw.length() > maximum + 256 || raw.getBytes(StandardCharsets.UTF_8).length > maximum + 256) throw new Exception();
      validateLexicalStrings(raw);
      String pubkey = null, content = null, tags = null;
      long createdAt = -1, kind = -1;
      Set<String> fields = new HashSet<>();
      try (JsonReader reader = new JsonReader(new StringReader(raw))) {
        reader.setLenient(false); reader.beginObject();
        while (reader.hasNext()) {
          String name = reader.nextName();
          if (!fields.add(name)) throw new Exception();
          switch (name) {
            case "pubkey": pubkey = text(reader); break;
            case "content": content = text(reader); break;
            case "created_at": createdAt = integer(reader, 9_007_199_254_740_991L); break;
            case "kind": kind = integer(reader, 65535); break;
            case "tags": tags = tags(reader); break;
            default: throw new Exception();
          }
        }
        reader.endObject();
        if (reader.peek() != JsonToken.END_DOCUMENT) throw new Exception();
      }
      if (fields.size() != 5 || pubkey == null || !pubkey.matches("[0-9a-f]{64}") || !pubkey.equals(expectedPubkey) || content == null || tags == null || createdAt < 0 || kind < 0) throw new Exception();
      return new NativeEvent(pubkey, createdAt, (int)kind, tags, content, maximum);
    } catch (Exception failure) { throw new NativeSignerCore.Denied(); }
  }
  /** JsonReader does not reject raw controls inside strings on all Android versions. */
  static void validateLexicalStrings(String raw) {
    boolean string = false;
    for (int i = 0; i < raw.length(); i++) {
      char value = raw.charAt(i);
      if (!string) {
        if (value == '"') string = true;
        else if (value < 32 && value != '\t' && value != '\r' && value != '\n') throw new NativeSignerCore.Denied();
        continue;
      }
      if (value < 32) throw new NativeSignerCore.Denied();
      if (value == '"') { string = false; continue; }
      if (value != '\\') continue;
      if (++i >= raw.length()) throw new NativeSignerCore.Denied();
      char escape = raw.charAt(i);
      if (escape == 'u') {
        for (int hex = 0; hex < 4; hex++) {
          if (++i >= raw.length() || Character.digit(raw.charAt(i), 16) < 0 || raw.charAt(i) > 127) throw new NativeSignerCore.Denied();
        }
      } else if ("\"\\/bfnrt".indexOf(escape) < 0) throw new NativeSignerCore.Denied();
    }
    if (string) throw new NativeSignerCore.Denied();
  }
  private static long integer(JsonReader reader, long maximum) throws Exception {
    if (reader.peek() != JsonToken.NUMBER) throw new Exception();
    String lexical = reader.nextString();
    if (!lexical.matches("0|[1-9][0-9]{0,15}")) throw new Exception();
    long result = Long.parseLong(lexical);
    if (result > maximum) throw new Exception();
    return result;
  }
  private static String text(JsonReader reader) throws Exception {
    if (reader.peek() != JsonToken.STRING) throw new Exception();
    String value = reader.nextString(); quote(value); return value;
  }
  private static String tags(JsonReader reader) throws Exception {
    StringBuilder result = new StringBuilder("[");
    reader.beginArray(); int rows = 0, items = 0;
    while (reader.hasNext()) {
      rows++;
      if (rows > 1) result.append(',');
      result.append('['); reader.beginArray(); int row = 0;
      while (reader.hasNext()) {
        items++;
        if (row++ > 0) result.append(',');
        result.append(quote(text(reader)));
      }
      if (row==0) throw new Exception();
      reader.endArray(); result.append(']');
    }
    reader.endArray(); return result.append(']').toString();
  }
  /** Matches JSON.stringify escapes without slash escaping; isolated UTF-16 surrogates fail. */
  static String quote(String value) {
    StringBuilder result = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char next = value.charAt(i);
      if (Character.isHighSurrogate(next)) {
        if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw new NativeSignerCore.Denied();
        result.append(next).append(value.charAt(i)); continue;
      }
      if (Character.isLowSurrogate(next)) throw new NativeSignerCore.Denied();
      switch (next) {
        case '"': result.append("\\\""); break;
        case '\\': result.append("\\\\"); break;
        case '\b': result.append("\\b"); break;
        case '\f': result.append("\\f"); break;
        case '\n': result.append("\\n"); break;
        case '\r': result.append("\\r"); break;
        case '\t': result.append("\\t"); break;
        default:
          if (next < 32) result.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int)next));
          else result.append(next);
      }
    }
    return result.append('"').toString();
  }
  static String hex(byte[] value) {
    char[] alphabet = "0123456789abcdef".toCharArray(); char[] result = new char[value.length * 2];
    for (int i = 0; i < value.length; i++) { result[2*i] = alphabet[(value[i] & 255) >>> 4]; result[2*i+1] = alphabet[value[i] & 15]; }
    return new String(result);
  }
  String signed(String signature) { return unsigned.substring(0, unsigned.length()-1) + ",\"id\":\"" + hex(digest) + "\",\"sig\":\"" + signature + "\"}"; }
}
