package org.nostrocket.hypergolic.signercore;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native-only CEP-4 envelope owner. MCP stays opaque; no user-vault key or generic bridge export. */
final class NativeCvmEnvelope implements AutoCloseable {
  static final int MAX_MESSAGE = 32 * 1024, MAX_EVENT = 64 * 1024;
  private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();
  interface Authority {
    void current();
    /** The real source facade must bind exact approved/control bytes before any network-effectful send. */
    void outgoing(String message, String recipient);
  }
  private final Authority authority;
  private final NativeSigningKey client;
  private final String peer;
  private boolean closed;
  private boolean released, uncertainRelease;
  private boolean announced;
  static final class Prepared {
    final String wire, innerEventId;
    private Prepared(String wire, String innerEventId) { this.wire = wire; this.innerEventId = innerEventId; }
  }
  static final class Decoded {
    final String message, eventId, paymentInteraction;
    final List<String> references;
    Decoded(String message, String eventId, List<String> references, String paymentInteraction) {
      this.message = message; this.eventId = eventId; this.references = java.util.Collections.unmodifiableList(new ArrayList<>(references)); this.paymentInteraction = paymentInteraction;
    }
  }
  NativeCvmEnvelope(String peer, Authority authority) {
    if (authority == null) throw denied();
    authority.current(); if (!NativeSigningKey.validPublicKey(peer)) throw denied(); this.authority = authority; this.peer = peer; client = new NativeSigningKey();
  }
  private static IllegalStateException denied() { return new IllegalStateException("CVM envelope denied"); }
  private void check() { if (closed) throw denied(); authority.current(); }
  synchronized String clientPublicKey() { check(); return client.publicKey(); }
  synchronized String encode(String message, long now, boolean ephemeralWrap) {
    return encode(message, now, ephemeralWrap, null);
  }
  synchronized String encode(String message, long now, boolean ephemeralWrap, String replyTo) {
    return prepare(message, now, ephemeralWrap, replyTo).wire;
  }
  synchronized Prepared prepare(String message, long now, boolean ephemeralWrap, String replyTo) {
    check();
    if (message == null || message.getBytes(StandardCharsets.UTF_8).length > MAX_MESSAGE || now < 0 || now > 9_007_199_254_740_991L) throw denied();
    authority.outgoing(message, peer);check();
    String clientPubkey = client.publicKey();
    if (replyTo != null && !replyTo.matches("[0-9a-f]{64}")) throw denied();
    NativeEvent inner = event(clientPubkey, now, 25910, eventTags(peer, replyTo, !announced), message);
    byte[] clear = inner.signed(client.sign(inner.digest)).getBytes(StandardCharsets.UTF_8);
    byte[] encrypted = null;
    try (NativeSigningKey wrapping = new NativeSigningKey()) {
      check(); encrypted = wrapping.transport(peer, clear, true); check();
      String content = utf8(encrypted);
      long wrappedTime = now - RANDOM.nextInt((int)Math.min(now, 172800) + 1);
      NativeEvent outer = event(wrapping.publicKey(), wrappedTime, ephemeralWrap ? 21059 : 1059, eventTags(peer, null, false), content);
      String signed = outer.signed(wrapping.sign(outer.digest));
      if (signed.getBytes(StandardCharsets.UTF_8).length > MAX_EVENT) throw denied();
      check(); announced = true; return new Prepared(signed, NativeEvent.hex(inner.digest));
    } finally {
      Arrays.fill(clear, (byte)0); if (encrypted != null) Arrays.fill(encrypted, (byte)0);
    }
  }
  synchronized Decoded decode(String signed, long now) {
    check();
    if (signed == null || signed.getBytes(StandardCharsets.UTF_8).length > MAX_EVENT || now < 0 || now > 9_007_199_254_740_991L) throw denied();
    JSONObject input = NativeRpcJson.object(signed);
    Object pubkey = input.opt("pubkey");
    if (!(pubkey instanceof String) || !NativeSigningKey.validPublicKey((String)pubkey)) throw denied();
    NativeSignedEvent wrapper = NativeSignedEvent.verify(input, (String)pubkey, MAX_EVENT);
    NativeEvent outer = wrapper.event;
    if ((outer.kind != 1059 && outer.kind != 21059) || outer.createdAt > now + 30 ||
        now > outer.createdAt + 172800 || !recipient(outer.tags, client.publicKey())) throw denied();
    check(); byte[] clear = client.transport((String)pubkey, outer.content.getBytes(StandardCharsets.UTF_8), false);
    try {
      check();if (clear.length > MAX_EVENT) throw denied();
      NativeEvent inner = NativeSignedEvent.verify(NativeRpcJson.object(utf8(clear)), peer, MAX_EVENT).event;
      if (inner.kind != 25910 || inner.createdAt > now + 30 || now > inner.createdAt + 120 ||
          inner.content.getBytes(StandardCharsets.UTF_8).length > MAX_MESSAGE) throw denied();
      Decoded decoded = capture(inner, client.publicKey()); check(); return decoded;
    } finally { Arrays.fill(clear, (byte)0); }
  }
  private static String eventTags(String recipient, String replyTo, boolean announce) {
    String tags = "[[\"p\"," + NativeEvent.quote(recipient) + "]";
    if (replyTo != null) tags += ",[\"e\"," + NativeEvent.quote(replyTo) + "]";
    if (announce) tags += ",[\"support_encryption\"],[\"support_open_stream\"],[\"payment_interaction\",\"explicit_gating\"]";
    return tags + "]";
  }
  private static NativeEvent event(String pubkey, long now, int kind, String tags, String content) {
    String raw = "{\"pubkey\":" + NativeEvent.quote(pubkey) + ",\"created_at\":" + now + ",\"kind\":" + kind +
      ",\"tags\":" + tags + ",\"content\":" + NativeEvent.quote(content) + "}";
    return NativeEvent.capture(raw, pubkey, MAX_EVENT);
  }
  /** The owning trusted client must correlate authenticated e references to its actual sent inner IDs. */
  private static Decoded capture(NativeEvent inner, String client) {
    try {
      JSONArray tags = new JSONArray(inner.tags); int recipients = 0; String mode = null;
      List<String> references = new ArrayList<>();
      for (int index = 0; index < tags.length(); index++) {
        JSONArray tag = tags.getJSONArray(index); String name = tag.getString(0);
        if ("p".equals(name)) {
          if (tag.length() < 2 || !client.equals(tag.getString(1)) || ++recipients > 1) throw denied();
        } else if ("e".equals(name)) {
          if (tag.length() < 2 || !tag.getString(1).matches("[0-9a-f]{64}") || references.size() == 16) throw denied();
          references.add(tag.getString(1));
        } else if ("payment_interaction".equals(name)) {
          if (mode != null || tag.length() != 2 || !("explicit_gating".equals(tag.getString(1)) || "transparent".equals(tag.getString(1)))) throw denied();
          mode = tag.getString(1);
        }
      }
      if (recipients == 0 && references.isEmpty()) throw denied();
      return new Decoded(inner.content, NativeEvent.hex(inner.digest), references, mode);
    } catch (org.json.JSONException invalid) { throw denied(); }
  }
  private static boolean recipient(String raw, String expected) {
    try {
      JSONArray tags = new JSONArray(raw); int matches = 0;
      for (int index = 0; index < tags.length(); index++) {
        JSONArray tag = tags.getJSONArray(index);
        if ("p".equals(tag.getString(0))) {
          if (tag.length() < 2 || !expected.equals(tag.getString(1))) return false;
          matches++;
        }
      }
      return matches == 1;
    } catch (Exception invalid) { return false; }
  }
  private static String utf8(byte[] bytes) {
    try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
    catch (Exception invalid) { throw denied(); }
  }
  @Override public synchronized void close() {
    if (uncertainRelease) throw denied();
    if (released) return;
    closed = true;
    try { client.close(); released = true; }
    catch (RuntimeException | Error uncertain) { uncertainRelease = true; throw uncertain; }
  }
}
