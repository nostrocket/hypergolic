package org.nostrocket.hypergolic.signercore;

import android.util.JsonReader;
import android.util.JsonToken;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded strict protocol parser: duplicate keys and invalid Unicode never reach general JSON accessors. */
final class NativeRpcJson {
  static final int MAX_BYTES = 8 * 1024 * 1024;
  static Object parse(String raw) {
    try {
      if (raw == null || raw.length() > MAX_BYTES || raw.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new Exception();
      NativeEvent.validateLexicalStrings(raw);
      // Android strict JsonReader only admits object/array roots; NIP-46 also specifies JSON-string null.
      if (raw.trim().equals("null")) return JSONObject.NULL;
      try (JsonReader reader = new JsonReader(new StringReader(raw))) {
        reader.setLenient(false);
        Object result = value(reader, 0);
        if (reader.peek() != JsonToken.END_DOCUMENT) throw new Exception();
        return result;
      }
    } catch (Exception failure) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
  }
  private static Object value(JsonReader reader, int depth) throws Exception {
    if (depth > 16) throw new Exception();
    switch (reader.peek()) {
      case BEGIN_OBJECT:
        JSONObject object = new JSONObject();
        Set<String> names = new HashSet<>();
        reader.beginObject();
        while (reader.hasNext()) {
          String name = reader.nextName();
          NativeEvent.quote(name);
          if (!names.add(name)) throw new Exception();
          object.put(name, value(reader, depth + 1));
        }
        reader.endObject();
        return object;
      case BEGIN_ARRAY:
        JSONArray array = new JSONArray();
        reader.beginArray();
        while (reader.hasNext()) array.put(value(reader, depth + 1));
        reader.endArray();
        return array;
      case STRING:
        String text = reader.nextString();
        NativeEvent.quote(text);
        return text;
      case NUMBER:
        String number = reader.nextString();
        if (!number.matches("0|[1-9][0-9]{0,15}")) throw new Exception();
        long result = Long.parseLong(number);
        if (result > NativeVault.MAX_REVISION) throw new Exception();
        return result;
      case BOOLEAN:
        return reader.nextBoolean();
      case NULL:
        reader.nextNull();
        return JSONObject.NULL;
      default: throw new Exception();
    }
  }
  static JSONObject object(String raw) {
    Object value = parse(raw);
    if (!(value instanceof JSONObject)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    return (JSONObject)value;
  }
  static void fields(JSONObject object, String... names) {
    if (object.length() != names.length) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    for (String name : names) if (!object.has(name)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
  }
}
