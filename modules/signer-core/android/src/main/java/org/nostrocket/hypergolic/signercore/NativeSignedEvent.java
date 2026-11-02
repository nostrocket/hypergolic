package org.nostrocket.hypergolic.signercore;

import org.json.JSONObject;

/** Checks canonical event ID and Schnorr signature before any encrypted transport plaintext is opened. */
final class NativeSignedEvent {
  final NativeEvent event;
  final String signed;
  private NativeSignedEvent(NativeEvent event, String signed) { this.event = event; this.signed = signed; }
  static NativeSignedEvent verify(JSONObject object, String expectedPubkey, int maximum) {
    try {
      NativeRpcJson.fields(object, "pubkey", "created_at", "kind", "tags", "content", "id", "sig");
      Object id = object.get("id"), signature = object.get("sig");
      if (!(id instanceof String) || !(signature instanceof String)) throw new Exception();
      JSONObject unsigned = new JSONObject(object.toString());
      unsigned.remove("id");
      unsigned.remove("sig");
      NativeEvent captured = NativeEvent.capture(unsigned.toString(), expectedPubkey, maximum);
      if (!NativeEvent.hex(captured.digest).equals(id) || !NativeSigningKey.verify(expectedPubkey, captured.digest, (String)signature)) throw new Exception();
      return new NativeSignedEvent(captured, captured.signed((String)signature));
    } catch (Exception failure) { throw new NativeVault.Error("SIGNER_RESPONSE_INVALID"); }
  }
  static String exact(String raw, NativeEvent approved) {
    NativeSignedEvent returned = verify(NativeRpcJson.object(raw), approved.pubkey, NativeEvent.MAX_BYTES);
    if (!returned.event.canonical.equals(approved.canonical)) throw new NativeVault.Error("SIGNER_RESPONSE_INVALID");
    return returned.signed;
  }
}
