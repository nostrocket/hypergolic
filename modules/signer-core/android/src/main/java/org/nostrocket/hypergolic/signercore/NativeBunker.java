package org.nostrocket.hypergolic.signercore;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Native-entry parser. The full secret-bearing URI is never converted into an immutable String. */
final class NativeBunker implements AutoCloseable {
  final long deadline;
  final String peer;
  final List<String> relays;
  final char[] secret;
  private NativeBunker(String peer, List<String> relays, char[] secret) {
    long now = android.os.SystemClock.elapsedRealtime();
    if (now < 0 || now > Long.MAX_VALUE - 120_000L) throw new NativeVault.Error("SIGNER_EXPIRED");
    this.deadline = now + 120_000L;
    this.peer = peer;
    this.relays = NativeRemoteBinding.validateRelays(relays);
    this.secret = secret;
  }
  static NativeBunker parse(char[] input) {
    char[] secret = null;
    try {
      if (input == null || input.length < 74 || input.length > 8192) throw new Exception();
      String prefix = "bunker://";
      for (int index = 0; index < prefix.length(); index++) if (input[index] != prefix.charAt(index)) throw new Exception();
      for (char value : input) if (value <= 32 || value > 126 || value == '#') throw new Exception();
      String peer = new String(input, 9, 64);
      if (!NativeSigningKey.validPublicKey(peer) || input[73] != '?') throw new Exception();
      List<String> relays = new ArrayList<>();
      int begin = 74;
      while (begin < input.length) {
        int end = begin;
        while (end < input.length && input[end] != '&') end++;
        int separator = begin;
        while (separator < end && input[separator] != '=') separator++;
        if (separator == end) throw new Exception();
        String name = new String(input, begin, separator - begin);
        char[] value = decode(input, separator + 1, end);
        try {
          if (name.equals("relay")) relays.add(new String(value));
          else if (name.equals("secret") && secret == null && value.length > 0 && value.length <= 256) {
            secret = value;
            value = null;
          } else throw new Exception();
        } finally { if (value != null) Arrays.fill(value, '\0'); }
        begin = end + 1;
        if (end + 1 == input.length) throw new Exception();
      }
      return new NativeBunker(peer, relays, secret);
    } catch (Exception failure) {
      if (secret != null) Arrays.fill(secret, '\0');
      throw new NativeVault.Error("INVALID_SIGNER_CONNECTION");
    }
  }
  private static char[] decode(char[] input, int begin, int end) throws Exception {
    byte[] encoded = new byte[end - begin];
    int length = 0;
    try {
      for (int index = begin; index < end; index++) {
        int value = input[index];
        if (value == '%') {
          if (index + 2 >= end) throw new Exception();
          int high = Character.digit(input[++index], 16), low = Character.digit(input[++index], 16);
          if (high < 0 || low < 0) throw new Exception();
          value = (high << 4) | low;
        }
        if (value == 0 || value < 32 || value == 127) throw new Exception();
        encoded[length++] = (byte)value;
      }
      CharBuffer decoded = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(encoded, 0, length));
      char[] result = new char[decoded.remaining()];
      decoded.get(result);
      if (decoded.hasArray()) Arrays.fill(decoded.array(), '\0');
      return result;
    } finally { Arrays.fill(encoded, (byte)0); }
  }
  @Override public void close() { if (secret != null) Arrays.fill(secret, '\0'); }
}
