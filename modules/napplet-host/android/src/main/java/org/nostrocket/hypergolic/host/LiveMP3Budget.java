package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.util.function.LongSupplier;

/** One source's original clock and cumulative decrypted HTTP response budget, retained across pauses. */
final class LiveMP3Budget {
  static final int MAX_BYTES = 32 * 1024 * 1024;
  static final long SESSION_MS = 15 * 60 * 1000L;
  static final long STARTUP_MS = 15_000;
  static final int IDLE_MS = 10_000;
  private final LongSupplier clock;
  private final long started;
  private final long duration;
  private final int maximum;
  private int received;
  private long attemptStarted;
  private boolean output = true;
  private boolean cancelled;
  private boolean transport;
  private long lastByte;

  LiveMP3Budget() { this(() -> System.nanoTime() / 1_000_000L, MAX_BYTES, SESSION_MS); }
  LiveMP3Budget(LongSupplier clock, int maximum, long duration) {
    if (maximum < 1 || maximum > MAX_BYTES || duration < 1 || duration > SESSION_MS) throw new IllegalArgumentException();
    this.clock = clock; this.maximum = maximum; this.duration = duration;
    started = clock.getAsLong(); attemptStarted = started;
  }
  synchronized void beginAttempt() throws IOException { check(); output = false; attemptStarted = clock.getAsLong(); transport = true; lastByte = attemptStarted; }
  synchronized void pause() throws IOException { check(); output = true; transport = false; }
  synchronized void finishedTransport() throws IOException { check(); transport = false; }
  synchronized void markOutput() throws IOException { check(); output = true; }
  synchronized void check() throws IOException {
    long elapsed = clock.getAsLong() - started;
    if (cancelled || elapsed < 0 || elapsed >= duration) throw new IOException("Live source retired");
    if (transport && clock.getAsLong() - lastByte >= IDLE_MS) throw new IOException("Live input idle deadline");
    if (!output && clock.getAsLong() - attemptStarted >= STARTUP_MS) throw new IOException("Live startup deadline");
  }
  synchronized void charge(int bytes) throws IOException {
    check();
    if (bytes < 0 || bytes > maximum - received) throw new IOException("Live response byte limit");
    received += bytes; if (bytes > 0) lastByte = clock.getAsLong();
  }
  synchronized long remainingMillis() throws IOException { check(); return duration - (clock.getAsLong() - started); }
  synchronized int readAllowance() { return Math.min(8192, maximum - received + 1); }
  synchronized int received() { return received; }
  synchronized boolean active() { try { check(); return true; } catch (IOException denied) { return false; } }
  synchronized void cancel() { cancelled = true; }
}
