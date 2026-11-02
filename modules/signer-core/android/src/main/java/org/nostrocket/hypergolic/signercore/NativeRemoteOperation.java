package org.nostrocket.hypergolic.signercore;

import android.os.SystemClock;
import java.io.IOException;
import java.net.Socket;
import org.nostrocket.hypergolic.host.NativeSignerRelay;

/** Original native operation lifetime and raw socket cancellation, without holding locks during network I/O. */
final class NativeRemoteOperation implements NativeSignerRelay.Control, AutoCloseable {
  interface Guard { void check(); default void execute() { check(); } void beforeSigningSend(); }
  final long deadline;
  private final Guard guard;
  private volatile boolean cancelled, signingFrame, possibleSigningSend;
  private Socket socket;

  NativeRemoteOperation(long deadline, Guard guard) {
    if (deadline <= SystemClock.elapsedRealtime() || guard == null) throw new NativeVault.Error("SIGNER_EXPIRED");
    this.deadline = deadline;
    this.guard = guard;
  }
  void check() {
    if (cancelled) throw new NativeVault.Error(possibleSigningSend ? "SIGNER_UNCERTAIN" : "AUTHORIZATION_DENIED");
    if (SystemClock.elapsedRealtime() >= deadline) throw new NativeVault.Error(possibleSigningSend ? "SIGNER_UNCERTAIN" : "SIGNER_EXPIRED");
    try { guard.check(); }
    catch (RuntimeException failure) {
      if (possibleSigningSend) throw new NativeVault.Error("SIGNER_UNCERTAIN");
      throw failure;
    }
  }
  void execute() {
    check();
    try { guard.execute(); }
    catch (RuntimeException failure) {
      if (possibleSigningSend) throw new NativeVault.Error("SIGNER_UNCERTAIN");
      throw failure;
    }
  }
  void signingFrame() { execute(); signingFrame = true; }
  boolean uncertain() { return possibleSigningSend; }
  @Override public boolean isCancelled() {
    try { check(); return false; } catch (RuntimeException denied) { return true; }
  }
  @Override public void attach(Socket raw) throws IOException {
    synchronized (this) {
      if (!cancelled) { socket = raw; return; }
    }
    raw.close();
    throw new IOException("Native signer operation closed.");
  }
  @Override public void beforeSend() throws IOException {
    execute();
    if (signingFrame) {
      guard.beforeSigningSend();
      // Conservatively record uncertainty before the first possible socket write.
      possibleSigningSend = true;
    }
  }
  @Override public void close() {
    Socket current;
    synchronized (this) { cancelled = true; current = socket; socket = null; }
    if (current != null) try { current.close(); } catch (IOException ignored) {}
  }
}
