package org.nostrocket.hypergolic.signercore;

import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.Record;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;
import org.nostrocket.hypergolic.signercore.NativeVault.Error;
import static org.nostrocket.hypergolic.signercore.NativeVault.*;

/** Explicit method selection/removal. No automatic fallback when a selected capability is removed. */
final class NativeVaultMethods {
  private NativeVaultMethods() {}
  static void select(State state, Record value, String method) {
    int next;
    if ("local".equals(method)) {
      if (value.key == null) throw new Error("LOCAL_KEY_UNAVAILABLE");
      next = LOCAL;
    } else if ("nip46".equals(method)) {
      if (value.remote == null) throw new Error("SIGNER_UNAVAILABLE");
      next = NIP46;
    } else if ("nip55".equals(method)) {
      if (value.androidSigner == null) throw new Error("SIGNER_UNAVAILABLE");
      next = NIP55;
    } else throw new Error("SIGNER_UNSUPPORTED");
    if (value.method != next) { advance(state); value.method = next; }
  }
  static void disconnect(State state, Record value, String method) {
    int removed;
    if ("nip46".equals(method)) {
      if (value.remote == null) throw new Error("NOT_FOUND");
      removed = NIP46;
      advance(state);
      value.remote.close(); value.remote = null;
    } else if ("nip55".equals(method)) {
      if (value.androidSigner == null) throw new Error("NOT_FOUND");
      removed = NIP55;
      advance(state); value.androidSigner = null;
    } else throw new Error("SIGNER_UNSUPPORTED");
    if (value.method == removed) value.method = NO_METHOD;
  }
}
