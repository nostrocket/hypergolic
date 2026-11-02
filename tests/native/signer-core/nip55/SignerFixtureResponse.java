package org.nostrocket.hypergolic.signercore;

import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONObject;

/** Disposable public-vector signer responses, including deliberately invalid results. */
final class SignerFixtureResponse {
  static final String[] MODES = {"Valid result", "Reject", "App failure", "Null result", "Wrong id",
      "Wrong package", "Wrong user", "Changed content", "Changed tags", "Changed event ID",
      "Invalid signature", "Mismatched signature", "Missing event", "Malformed event",
      "Unknown extra", "Wrong extra type", "Large reply", "Crash", "Leave pending"};

  private SignerFixtureResponse() {}

  private static NativeSigningKey key(int vector) {
    byte[] scalar = new byte[32];
    scalar[31] = (byte) vector;
    try { return NativeSigningKey.importScalar(scalar); }
    finally { java.util.Arrays.fill(scalar, (byte) 0); }
  }

  static String publicKey() {
    try (NativeSigningKey key = key(9)) { return key.publicKey(); }
  }

  static Intent respond(String type, String payload, String id, String packageName, String mode) throws Exception {
    Intent result = new Intent().putExtra("id", mode.equals("Wrong id") ? id + "-stale" : id);
    if (mode.equals("Reject")) return result.putExtra("rejected", true);
    if (type.equals("get_public_key")) {
      try (NativeSigningKey key = key(mode.equals("Wrong user") ? 10 : 9)) {
        result.putExtra("result", key.publicKey());
      }
      result.putExtra("package", mode.equals("Wrong package") ? packageName + ".wrong" : packageName);
    } else {
      signed(result, payload, mode);
    }
    if (mode.equals("Unknown extra")) result.putExtra("unexpected", "fixture");
    if (mode.equals("Wrong extra type")) result.putExtra("result", 42);
    if (mode.equals("Large reply")) result.putExtra("event", "x".repeat(300_000));
    return result;
  }

  private static void signed(Intent result, String payload, String mode) throws Exception {
    JSONObject unsigned = new JSONObject(payload);
    try (NativeSigningKey key = key(mode.equals("Wrong user") ? 10 : 9)) {
      if (mode.equals("Wrong user")) unsigned.put("pubkey", key.publicKey());
      if (mode.equals("Changed content")) unsigned.put("content", unsigned.getString("content") + " changed");
      if (mode.equals("Changed tags")) unsigned.getJSONArray("tags").put(new JSONArray().put("fixture").put("changed"));
      NativeEvent event = NativeEvent.capture(unsigned.toString(), key.publicKey());
      String signature = key.sign(event.digest);
      JSONObject signed = new JSONObject(event.signed(signature));
      if (mode.equals("Changed event ID")) signed.put("id", "0".repeat(64));
      if (mode.equals("Invalid signature")) { signature = "0".repeat(128); signed.put("sig", signature); }
      result.putExtra("result", mode.equals("Mismatched signature") ? "0".repeat(128) : signature);
      if (!mode.equals("Missing event")) {
        result.putExtra("event", mode.equals("Malformed event") ? "{broken" : signed.toString());
      }
    }
  }
}
