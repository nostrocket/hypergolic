package org.nostrocket.hypergolic.signercore;

import java.util.function.BooleanSupplier;

/** Serializes native revocation with storage effects. Never calls an external authority under lock. */
final class NativeVaultSession {
  final Object lock = new Object();
  volatile boolean activated, actionBusy;
  volatile long epoch;
  private long actionEpoch;

  void activate(BooleanSupplier owner) {
    synchronized (lock) {
      if (epoch == Long.MAX_VALUE || !owner.getAsBoolean()) throw new NativeVault.Error("AUTHORIZATION_DENIED");
      activated = true;
    }
  }

  long beginAction(BooleanSupplier owner) {
    synchronized (lock) {
      require(epoch, owner);
      if (actionBusy) throw new NativeVault.Error("AUTHORIZATION_DENIED");
      actionBusy = true;
      actionEpoch = epoch;
      return epoch;
    }
  }

  void finishAction(long expectedEpoch) {
    synchronized (lock) { if (epoch == expectedEpoch) actionBusy = false; }
  }

  void require(long expectedEpoch, BooleanSupplier owner) {
    // Callers keep this monitor held through the corresponding native persistence/signing effect.
    if (!Thread.holdsLock(lock)) throw new IllegalStateException("Native effect requires session lock");
    if (!activated || epoch != expectedEpoch || !owner.getAsBoolean()) throw new NativeVault.Error("AUTHORIZATION_DENIED");
  }

  void requireAction(long expectedEpoch, BooleanSupplier owner) {
    require(expectedEpoch, owner);
    if (!actionBusy || actionEpoch != expectedEpoch) throw new NativeVault.Error("AUTHORIZATION_DENIED");
  }

  void invalidate(boolean background) {
    synchronized (lock) {
      if (background) activated = false;
      if (epoch == Long.MAX_VALUE) activated = false; else epoch++;
      actionBusy = false;
    }
  }
}
