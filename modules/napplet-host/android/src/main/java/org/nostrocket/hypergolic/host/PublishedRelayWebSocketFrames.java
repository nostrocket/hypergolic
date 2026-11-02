package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Bounded RFC 6455 server-to-client frame decoder. It does not perform I/O. */
public final class PublishedRelayWebSocketFrames {
  public static final int MAX_BYTES = 66_560;
  public static final int MAX_READ = 8_192;

  public static final class Event {
    public final String type;
    public final String text;
    public final byte[] bytes;
    public final int closeCode;
    public final String detail;
    private Event(String type, String text, byte[] bytes, int closeCode, String detail) {
      this.type = type; this.text = text; this.bytes = bytes; this.closeCode = closeCode; this.detail = detail;
    }
    static Event text(String value) { return new Event("text", value, null, 0, null); }
    static Event control(String type, byte[] value) { return new Event(type, null, value, 0, null); }
    static Event close(int code, String reason) { return new Event("close", reason, null, code, null); }
    static Event error(String value) { return new Event("error", null, null, 0, value); }
    public String normalized() {
      if ("text".equals(type)) return "TEXT:" + hex(text.getBytes(StandardCharsets.UTF_8));
      if ("ping".equals(type) || "pong".equals(type)) return type.toUpperCase() + ":" + hex(bytes);
      if ("close".equals(type)) return "CLOSE:" + closeCode + ":" + hex(text.getBytes(StandardCharsets.UTF_8));
      return "ERROR:" + detail;
    }
  }

  private final int maxBytes;
  private long completedFrames;
  private int consumedInput;
  public PublishedRelayWebSocketFrames() { maxBytes = MAX_BYTES; }
  /** Package-only larger bound for the native signer transport. */
  PublishedRelayWebSocketFrames(int maxBytes) {
    if (maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new IllegalArgumentException("Invalid frame bound");
    this.maxBytes = maxBytes;
  }
  long completedFrameCount() { return completedFrames; }
  int consumedInputBytes() { return consumedInput; }

  private enum State { BASE, EXTENDED, PAYLOAD }
  private State state = State.BASE;
  private final byte[] base = new byte[2];
  private int baseCount, extCount, extNeeded, headerSize, opcode, frameLength, frameRead;
  private byte[] extended = new byte[8];
  private byte[] framePayload;
  private int messageBytes;
  private ByteArrayOutputStream message;
  private boolean failed, closed;

  public List<Event> feed(byte[] input) {
    consumedInput = 0;
    ArrayList<Event> events = new ArrayList<>();
    if (input == null || input.length > MAX_READ) { fail(events, "read-too-large"); return events; }
    if (failed || closed) { fail(events, "closed"); return events; }
    int i = 0;
    while (i < input.length && !failed && !closed) {
      if (state == State.BASE) {
        base[baseCount++] = input[i++];
        if (baseCount == 2) beginHeader(events);
      } else if (state == State.EXTENDED) {
        int n = Math.min(extNeeded - extCount, input.length - i);
        System.arraycopy(input, i, extended, extCount, n); extCount += n; i += n;
        if (extCount == extNeeded) finishLength(events);
      } else {
        int n = Math.min(frameLength - frameRead, input.length - i);
        if (n > 0) { System.arraycopy(input, i, framePayload, frameRead, n); frameRead += n; i += n; }
        if (frameRead == frameLength) finishFrame(events);
      }
    }
    consumedInput = i;
    return events;
  }

  private void beginHeader(List<Event> events) {
    int a = base[0] & 255, b = base[1] & 255;
    if ((a & 0x70) != 0) { fail(events, "reserved-bits"); return; }
    if ((b & 0x80) != 0) { fail(events, "masked-server-frame"); return; }
    opcode = a & 15;
    boolean fin = (a & 0x80) != 0;
    int marker = b & 127;
    boolean control = opcode >= 8;
    if (!(opcode == 0 || opcode == 1 || opcode == 8 || opcode == 9 || opcode == 10)) { fail(events, "unsupported-opcode"); return; }
    if (control && (!fin || marker > 125)) { fail(events, "invalid-control-frame"); return; }
    if (opcode == 0 && message == null) { fail(events, "unexpected-continuation"); return; }
    if (opcode == 1 && message != null) { fail(events, "nested-fragment"); return; }
    baseCount = 0; headerSize = 2;
    if (marker < 126) { frameLength = marker; acceptLength(events); }
    else { extNeeded = marker == 126 ? 2 : 8; extCount = 0; state = State.EXTENDED; }
  }

  private void finishLength(List<Event> events) {
    if (extNeeded == 8 && (extended[0] & 0x80) != 0) { fail(events, "frame-too-large"); return; }
    long length = 0;
    for (int j = 0; j < extNeeded; j++) length = (length << 8) | (extended[j] & 255L);
    if ((extNeeded == 2 && length < 126) || (extNeeded == 8 && length < 65_536)) { fail(events, "noncanonical-length"); return; }
    if (length > maxBytes) { fail(events, "frame-too-large"); return; }
    frameLength = (int) length; headerSize += extNeeded; acceptLength(events);
  }

  private void acceptLength(List<Event> events) {
    if (headerSize + frameLength > maxBytes) { fail(events, "frame-too-large"); return; }
    if (opcode < 8) {
      int prior = opcode == 1 ? 0 : messageBytes;
      if (frameLength > maxBytes - prior) { fail(events, "message-too-large"); return; }
    }
    framePayload = new byte[frameLength]; frameRead = 0; state = State.PAYLOAD;
    if (frameLength == 0) finishFrame(events);
  }

  private void finishFrame(List<Event> events) {
    completedFrames++;
    try {
      if (opcode == 1 || opcode == 0) {
        if (opcode == 1) { message = new ByteArrayOutputStream(Math.min(frameLength, 4096)); messageBytes = 0; }
        message.write(framePayload, 0, framePayload.length); messageBytes += framePayload.length;
        boolean fin = (base[0] & 0x80) != 0;
        // Continuation FIN is captured separately because base is reused only after this frame.
        if (fin) { byte[] all = message.toByteArray(); String value = decode(all); events.add(Event.text(value)); message = null; messageBytes = 0; }
      } else if (opcode == 9) events.add(Event.control("ping", framePayload));
      else if (opcode == 10) events.add(Event.control("pong", framePayload));
      else {
        if (framePayload.length == 1) { fail(events, "invalid-close-payload"); return; }
        int code = 1005; String reason = "";
        if (framePayload.length >= 2) {
          code = ((framePayload[0] & 255) << 8) | (framePayload[1] & 255);
          if (!validCloseCode(code)) { fail(events, "invalid-close-code"); return; }
          reason = decode(slice(framePayload, 2));
        }
        events.add(Event.close(code, reason)); closed = true;
      }
      resetFrame();
    } catch (CharacterCodingException ex) { fail(events, "invalid-utf8"); }
  }

  private static String decode(byte[] bytes) throws CharacterCodingException {
    return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
  }
  private static boolean validCloseCode(int c) { return c >= 1000 && c < 5000 && c != 1004 && c != 1005 && c != 1006 && c != 1015 && !(c >= 1016 && c < 3000); }
  private static byte[] slice(byte[] b, int from) { byte[] r = new byte[b.length-from]; System.arraycopy(b,from,r,0,r.length); return r; }
  private void resetFrame() { state = State.BASE; baseCount = extCount = frameLength = frameRead = headerSize = 0; framePayload = null; }
  private void fail(List<Event> events, String code) { if (!failed) events.add(Event.error(code)); failed = true; framePayload = null; message = null; messageBytes = 0; }
  private static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x & 255)); return s.toString(); }
}
