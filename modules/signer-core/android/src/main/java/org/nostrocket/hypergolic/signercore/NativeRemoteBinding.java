package org.nostrocket.hypergolic.signercore;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.nostrocket.hypergolic.host.NativeSignerRelay;

/** Native-owned transport capability. Its client scalar never appears in public metadata. */
final class NativeRemoteBinding implements AutoCloseable {
  final NativeSigningKey client;
  final String peer;
  final List<String> relays;

  NativeRemoteBinding(NativeSigningKey client, String peer, List<String> relays) {
    if (client == null || !NativeSigningKey.validPublicKey(peer)) {
      throw new NativeVault.Error("INVALID_SIGNER_CONNECTION");
    }
    this.client = client;
    this.peer = peer;
    this.relays = validateRelays(relays);
  }

  static List<String> validateRelays(List<String> values) {
    if (values == null || values.isEmpty() || values.size() > 3) {
      throw new NativeVault.Error("INVALID_SIGNER_CONNECTION");
    }
    List<String> result = new ArrayList<>();
    for (String value : values) {
      try {
        if (value == null || value.length() > 2048 || !NativeSignerRelay.canonical(value).equals(value) || result.contains(value)) {
          throw new IOException();
        }
      } catch (IOException failure) {
        throw new NativeVault.Error("INVALID_SIGNER_CONNECTION");
      }
      result.add(value);
    }
    return Collections.unmodifiableList(result);
  }

  NativeRemoteBinding copy() {
    NativeSigningKey copied = client.copy();
    try { return new NativeRemoteBinding(copied, peer, relays); }
    catch (RuntimeException failure) { copied.close(); throw failure; }
  }

  @Override public void close() { client.close(); }
}
