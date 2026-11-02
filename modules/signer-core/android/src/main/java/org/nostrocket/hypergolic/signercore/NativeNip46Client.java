package org.nostrocket.hypergolic.signercore;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.host.NativeSignerRelay;

/** One in-flight NIP-46 RPC, with authenticated peer envelopes and no retry after a possible signing send. */
final class NativeNip46Client implements AutoCloseable {
  interface Authorization { void challenge(String requestId, String url); void awaitResume(String requestId) throws InterruptedException; }
  private Authorization authorization;
  private String lastResultId;
  NativeNip46Client authorization(Authorization value) { authorization=value; return this; }
  private void acceptedResult() {
    try { if(authorization!=null) authorization.awaitResume(lastResultId); operation.execute(); }
    catch(InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new NativeVault.Error(operation.uncertain() ? "SIGNER_UNCERTAIN" : "AUTHORIZATION_DENIED");
    }
    catch(NativeVault.Error failure) {
      if (operation.uncertain() && ("AUTHORIZATION_DENIED".equals(failure.code) || "SIGNER_EXPIRED".equals(failure.code))) {
        throw new NativeVault.Error("SIGNER_UNCERTAIN");
      }
      throw failure;
    }
  }
  interface Relays { NativeSignerRelay open(String relay, NativeRemoteOperation operation, NativeSignerRelay.Budget budget) throws IOException; }
  private final NativeRemoteBinding binding;
  private final NativeRemoteOperation operation;
  private final NativeSignerRelay.Budget budget;
  private final Relays relays;
  private final String subscription = UUID.randomUUID().toString();
  private NativeSignerRelay relay;

  NativeNip46Client(NativeRemoteBinding binding, NativeRemoteOperation operation) {
    this(binding, operation, new NativeSignerRelay.Budget());
  }
  NativeNip46Client(NativeRemoteBinding binding, NativeRemoteOperation operation, NativeSignerRelay.Budget budget) {
    this(binding, operation, budget, (url, control, bounds) -> NativeSignerRelay.open(url, control, control.deadline, bounds));
  }
  /** Native owning-test transport seam; never exported through Expo or a production switch. */
  NativeNip46Client(NativeRemoteBinding binding, NativeRemoteOperation operation, Relays relays) {
    this(binding, operation, new NativeSignerRelay.Budget(), relays);
  }
  NativeNip46Client(NativeRemoteBinding binding, NativeRemoteOperation operation, NativeSignerRelay.Budget budget, Relays relays) {
    this.budget = budget;
    this.binding = binding;
    this.operation = operation;
    this.relays = relays;
  }
  private void open() throws Exception {
    if (relay != null) return;
    for (String url : binding.relays) {
      operation.check();
      try { relay = relays.open(url, operation, budget); break; }
      catch (IOException unavailable) { operation.check(); }
    }
    if (relay == null) throw new NativeVault.Error("SIGNER_UNAVAILABLE");
    JSONObject filter = new JSONObject().put("authors", new JSONArray().put(binding.peer))
      .put("kinds", new JSONArray().put(24133)).put("#p", new JSONArray().put(binding.client.publicKey()))
      .put("since", Math.max(0, System.currentTimeMillis() / 1000 - 600));
    relay.send(new JSONArray().put("REQ").put(subscription).put(filter).toString());
  }
  private static void bytes(NativeSecretBuffer out, String value) throws IOException {
    byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
    try { out.write(encoded); } finally { Arrays.fill(encoded, (byte)0); }
  }
  private static void secret(NativeSecretBuffer out, char[] value) throws Exception {
    out.write('"');
    char[] escaped = new char[value.length * 2];
    int length = 0;
    byte[] encoded = null;
    try {
      for (char next : value) {
        if (next < 32) throw new Exception();
        if (next == '"' || next == '\\') escaped[length++] = '\\';
        escaped[length++] = next;
      }
      ByteBuffer bytes = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(escaped, 0, length));
      encoded = new byte[bytes.remaining()];
      bytes.get(encoded);
      if (bytes.hasArray()) Arrays.fill(bytes.array(), (byte)0);
      out.write(encoded);
    } finally {
      Arrays.fill(escaped, '\0');
      if (encoded != null) Arrays.fill(encoded, (byte)0);
    }
    out.write('"');
  }
  private byte[] request(String id, String method, List<String> params, char[] token) throws Exception {
    try (NativeSecretBuffer out = new NativeSecretBuffer(128)) {
      bytes(out, "{\"id\":" + NativeEvent.quote(id) + ",\"method\":" + NativeEvent.quote(method) + ",\"params\":[");
      for (int index = 0; index < params.size(); index++) {
        if (index > 0) out.write(',');
        if (method.equals("connect") && index == 1 && token != null) secret(out, token);
        else bytes(out, NativeEvent.quote(params.get(index)));
      }
      bytes(out, "]}");
      if (out.size() > 4_202_496) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
      return out.toByteArray();
    }
  }
  private Object call(String method, List<String> params, char[] token) {
    byte[] clear = null, encrypted = null;
    try {
      operation.execute();
      String id = UUID.randomUUID().toString();
      clear = request(id, method, params, token);
      encrypted = binding.client.transport(binding.peer, clear, true);
      String content = new String(encrypted, StandardCharsets.US_ASCII);
      String pubkey = binding.client.publicKey();
      JSONObject unsigned = new JSONObject().put("pubkey", pubkey).put("created_at", System.currentTimeMillis() / 1000)
        .put("kind", 24133).put("tags", new JSONArray().put(new JSONArray().put("p").put(binding.peer))).put("content", content);
      NativeEvent event = NativeEvent.capture(unsigned.toString(), pubkey, NativeRpcJson.MAX_BYTES);
      String outgoing = new JSONArray().put("EVENT").put(new JSONObject(event.signed(binding.client.sign(event.digest)))).toString();
      if (outgoing.getBytes(StandardCharsets.UTF_8).length > NativeRpcJson.MAX_BYTES) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
      open();
      operation.check();
      if (method.equals("sign_event")) operation.signingFrame();
      relay.send(outgoing);
      while (true) {
        operation.check();
        String incoming = relay.read();
        if (incoming == null) throw new IOException("Native signer relay closed.");
        Object frame = NativeRpcJson.parse(incoming);
        if (!(frame instanceof JSONArray)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
        JSONArray envelope = (JSONArray)frame;
        if (envelope.length() == 0 || !(envelope.get(0) instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
        if (!"EVENT".equals(envelope.getString(0))) continue;
        if (envelope.length() != 3 || !subscription.equals(envelope.get(1)) || !(envelope.get(2) instanceof JSONObject)) continue;
        JSONObject outer = envelope.getJSONObject(2);
        if (!binding.peer.equals(outer.opt("pubkey"))) continue;
        NativeSignedEvent verified = NativeSignedEvent.verify(outer, binding.peer, NativeRpcJson.MAX_BYTES);
        if (verified.event.kind != 24133 || !verified.event.tags.equals("[[\"p\",\"" + pubkey + "\"]]")) continue;
        byte[] payload = verified.event.content.getBytes(StandardCharsets.US_ASCII);
        byte[] plaintext = null;
        try {
          try { plaintext = binding.client.transport(binding.peer, payload, false); }
          catch (NativeSignerCore.Denied invalid) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
          String decoded = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plaintext)).toString();
          JSONObject response = NativeRpcJson.object(decoded);
          if (!(response.opt("id") instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
          if (!id.equals(response.getString("id"))) continue;
          if (response.length() < 2 || response.length() > 3) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
          java.util.Iterator<String> fields = response.keys();
          while (fields.hasNext()) if (!Arrays.asList("id", "result", "error").contains(fields.next())) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
          if ("auth_url".equals(response.opt("result")) && response.opt("error") instanceof String) {
            if(authorization==null) throw new NativeVault.Error("SIGNER_UNSUPPORTED");
            authorization.challenge(id,response.getString("error"));
            continue; // Receive the final authenticated reply on this subscription and ID; never resend.
          }
          if (response.has("error") && !response.isNull("error")) {
            if (!(response.get("error") instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
            throw new NativeVault.Error("SIGNER_REJECTED");
          }
          if (!response.has("result")) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
          operation.check();
          lastResultId=id;
          return response.get("result");
        } finally {
          Arrays.fill(payload, (byte)0);
          if (plaintext != null) Arrays.fill(plaintext, (byte)0);
        }
      }
    } catch (NativeVault.Error failure) {
      if (operation.uncertain() && ("AUTHORIZATION_DENIED".equals(failure.code) || "SIGNER_EXPIRED".equals(failure.code))) {
        throw new NativeVault.Error("SIGNER_UNCERTAIN");
      }
      throw failure;
    }
    catch (Exception failure) {
      throw new NativeVault.Error(operation.uncertain() ? "SIGNER_UNCERTAIN" : "SIGNER_UNAVAILABLE");
    } finally {
      if (clear != null) Arrays.fill(clear, (byte)0);
      if (encrypted != null) Arrays.fill(encrypted, (byte)0);
    }
  }
  String connect(char[] token) {
    Object response = call("connect", Arrays.asList(binding.peer, "", "sign_event", "{\"name\":\"Hypergolic\"}"), token);
    boolean accepted = "ack".equals(response);
    if (!accepted && response instanceof String && token != null) {
      String value = (String)response;
      int difference = value.length() ^ token.length;
      for (int index = 0; index < token.length; index++) difference |= token[index] ^ (index < value.length() ? value.charAt(index) : 0);
      accepted = difference == 0;
    }
    if (!accepted) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    acceptedResult();
    return publicKey();
  }
  String publicKey() { return publicKey(null); }
  String publicKey(String expectedUser) {
    Object publicKey = call("get_public_key", java.util.Collections.emptyList(), null);
    if (!(publicKey instanceof String) || !NativeSigningKey.validPublicKey((String)publicKey)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    if (expectedUser != null && !expectedUser.equals(publicKey)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    acceptedResult();
    return (String)publicKey;
  }
  List<String> switchRelays() { return switchRelays(null); }
  private List<String> switchRelays(List<String> expected) {
    Object response = call("switch_relays", java.util.Collections.emptyList(), null);
    if (response instanceof String) response = NativeRpcJson.parse((String)response);
    if (response == JSONObject.NULL) { acceptedResult(); return binding.relays; }
    if (!(response instanceof JSONArray)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    JSONArray values = (JSONArray)response;
    List<String> result = new ArrayList<>();
    try {
      for (int index = 0; index < values.length(); index++) {
        if (!(values.get(index) instanceof String)) throw new Exception();
        result.add(values.getString(index));
      }
      List<String> validated=NativeRemoteBinding.validateRelays(result);
      if (expected != null && !expected.equals(validated)) throw new NativeVault.Error("SIGNER_RELAYS_CHANGED");
      acceptedResult();
      return validated;
    } catch (NativeVault.Error failure) { throw failure; }
    catch (Exception failure) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
  }
  String sign(NativeEvent approved) {
    publicKey(approved.pubkey);
    switchRelays(binding.relays);
    String template = "{\"kind\":" + approved.kind + ",\"created_at\":" + approved.createdAt + ",\"tags\":" + approved.tags + ",\"content\":" + NativeEvent.quote(approved.content) + "}";
    Object response = call("sign_event", java.util.Collections.singletonList(template), null);
    if (!(response instanceof String)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    String exact=NativeSignedEvent.exact((String)response, approved);
    acceptedResult();
    return exact;
  }
  @Override public void close() { if (relay != null) relay.close(); }
}
