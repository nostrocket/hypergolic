package org.nostrocket.hypergolic.signercore;

/** A cancelled reply after a durable native write must invalidate the JavaScript public cache. */
final class NativeMutationReceipt {
  private final NativeVault vault;
  private final long before;
  NativeMutationReceipt(NativeVault vault) { this.vault = vault; before = vault.committedWrites(); }
  RuntimeException failure(Exception cause) {
    if (vault.committedWrites() != before) return new NativeVault.Error("READBACK_FAILED");
    if (cause instanceof RuntimeException) return (RuntimeException)cause;
    return new NativeVault.Error("AUTHORIZATION_DENIED");
  }
}
