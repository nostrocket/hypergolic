package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/** Bounded RFC 6455 client-to-server frame encoder; performs no I/O or fragmentation. */
public final class PublishedRelayWebSocketClientFrames {
  public static final int MAX_RAW_BYTES = 66_560;
  public static final int MAX_TEXT_BYTES = 8_192;
  private static final int MAX_CONTROL_BYTES = 125;
  private static final SecureRandom RANDOM = new SecureRandom();

  private PublishedRelayWebSocketClientFrames() {}

  /** Encodes one final UTF-8 text frame for the bounded relay lookup path. */
  public static byte[] textReq(String text) {
    return textReq(text, randomMask());
  }

  /** Deterministic proof overload. The mask is copied into the frame and must be exactly four bytes. */
  public static byte[] textReq(String text, byte[] mask) {
    return boundedText(text, mask, MAX_TEXT_BYTES, MAX_RAW_BYTES);
  }

  /** Package-only larger frame profile; ordinary public methods retain their caps. */
  static byte[] textReq(String text, int maxBytes) {
    return textReq(text, randomMask(), maxBytes);
  }
  static byte[] textReq(String text, byte[] mask, int maxBytes) {
    if (maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw invalid();
    return boundedText(text, mask, maxBytes, maxBytes);
  }
  private static byte[] boundedText(String text, byte[] mask, int maxText, int maxRaw) {
    if (text == null || text.length() > maxText) throw invalid();
    byte[] payload = strictUtf8(text);
    if (payload.length > maxText) throw invalid();
    return encode(0x1, payload, mask, maxText, maxRaw);
  }

  /** Encodes a pong that echoes the payload of a received ping. */
  public static byte[] pong(byte[] pingPayload) {
    return pong(pingPayload, randomMask());
  }

  /** Deterministic proof overload. */
  public static byte[] pong(byte[] pingPayload, byte[] mask) {
    if (pingPayload == null || pingPayload.length > MAX_CONTROL_BYTES) throw invalid();
    return encode(0xA, pingPayload.clone(), mask);
  }

  /** Encodes one close control frame with a status code and optional UTF-8 reason. */
  public static byte[] close(int code, String reason) {
    return close(code, reason, randomMask());
  }

  /** Deterministic proof overload. */
  public static byte[] close(int code, String reason, byte[] mask) {
    if (!validCloseCode(code) || reason == null || reason.length() > MAX_CONTROL_BYTES - 2) throw invalid();
    byte[] reasonBytes = strictUtf8(reason);
    if (reasonBytes.length > MAX_CONTROL_BYTES - 2) throw invalid();
    ByteArrayOutputStream payload = new ByteArrayOutputStream(2 + reasonBytes.length);
    payload.write((code >>> 8) & 0xff);
    payload.write(code & 0xff);
    payload.write(reasonBytes, 0, reasonBytes.length);
    return encode(0x8, payload.toByteArray(), mask);
  }

  private static byte[] encode(int opcode, byte[] payload, byte[] mask) {
    return encode(opcode, payload, mask, MAX_TEXT_BYTES, MAX_RAW_BYTES);
  }
  private static byte[] encode(int opcode, byte[] payload, byte[] mask, int maxText, int maxRaw) {
    int lengthBytes = payload.length <= 125 ? 0 : payload.length <= 65_535 ? 2 : 8;
    int payloadOffset = 2 + lengthBytes + 4;
    if (mask == null || mask.length != 4 || payload.length + payloadOffset > maxRaw) throw invalid();
    if (payload.length > maxText || payload.length > MAX_CONTROL_BYTES && opcode >= 8) throw invalid();
    byte[] output = new byte[payload.length + payloadOffset];
    output[0] = (byte) (0x80 | opcode);
    output[1] = (byte) (0x80 | (lengthBytes == 0 ? payload.length : lengthBytes == 2 ? 126 : 127));
    if (lengthBytes == 2) {
      output[2] = (byte) ((payload.length >>> 8) & 0xff);
      output[3] = (byte) (payload.length & 0xff);
    } else if (lengthBytes == 8) {
      for (int i = 0; i < 8; i++) output[2 + i] = (byte) ((long) payload.length >>> ((7 - i) * 8));
    }
    System.arraycopy(mask, 0, output, 2 + lengthBytes, 4);
    for (int i = 0; i < payload.length; i++) output[payloadOffset + i] = (byte) (payload[i] ^ mask[i & 3]);
    return output;
  }

  private static byte[] randomMask() {
    byte[] mask = new byte[4];
    RANDOM.nextBytes(mask);
    return mask;
  }

  private static byte[] strictUtf8(String value) {
    try {
      ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .encode(java.nio.CharBuffer.wrap(value));
      byte[] result = new byte[encoded.remaining()];
      encoded.get(result);
      return result;
    } catch (CharacterCodingException invalidUtf8) { throw invalid(); }
  }

  private static boolean validCloseCode(int code) {
    return code >= 1000 && code < 5000 && code != 1004 && code != 1005 && code != 1006
        && code != 1015 && !(code >= 1016 && code < 3000);
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException("Invalid bounded WebSocket client frame");
  }
}
