package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.util.function.LongSupplier;

/** Pure lifetime/authority state. Only a trusted native button may call nativePlay. */
final class LiveMP3Owner {
  static final String PROFILE = "finite-live-mp3-v1";
  enum Phase { OFFERED, BUFFERING, PLAYING, STOPPING, PAUSED, ENDED }
  private final String profile, scope;
  private final LongSupplier clock;
  private final long duration;
  private LiveMP3Budget budget;
  private Phase phase = Phase.OFFERED;
  private String receipt;
  private long attempt;
  private boolean network, decoder;
  private boolean terminal;
  private Object retained;
  private boolean uncertain, terminalTaken;
  private String reason;
  LiveMP3Owner(String profile, String scope) { this(profile, scope, () -> System.nanoTime() / 1_000_000L, LiveMP3Budget.SESSION_MS); }
  LiveMP3Owner(String profile, String scope, LongSupplier clock, long duration) {
    this.profile = profile; this.scope = scope; this.clock = clock; this.duration = duration;
  }
  synchronized long nativePlay(String currentScope, String currentReceipt, boolean foreground, boolean focused) throws IOException {
    if (!PROFILE.equals(profile) || !scope.equals(currentScope) || currentReceipt == null || !foreground || !focused ||
        terminal || network || decoder || !MediaPlaybackReservation.acquire(this)) throw new IOException("Live Play is unavailable");
    try {
      if (budget == null) budget = new LiveMP3Budget(clock, LiveMP3Budget.MAX_BYTES, duration);
      budget.beginAttempt();
      receipt = currentReceipt; attempt++; network = true; decoder = true; phase = Phase.BUFFERING;
      return attempt;
    } catch (IOException | RuntimeException invalid) { MediaPlaybackReservation.release(this); terminal = true; phase = Phase.ENDED; reason = "policy"; throw invalid; }
  }
  synchronized void retain(Object value) { if (network || decoder) retained = value; }
  synchronized void check(long token, String currentScope, String currentReceipt, boolean foreground, boolean focused) throws IOException {
    if (terminal || token != attempt || !scope.equals(currentScope) || receipt == null || !receipt.equals(currentReceipt) ||
        !foreground || !focused || phase != Phase.BUFFERING && phase != Phase.PLAYING) throw new IOException("Stale live authority");
    budget.check();
  }
  synchronized void output(long token) throws IOException {
    if (terminal || token != attempt || phase != Phase.BUFFERING) throw new IOException("Stale live output");
    budget.markOutput(); phase = Phase.PLAYING;
  }
  synchronized void pause() {
    if (terminal) return;
    receipt = null; phase = network || decoder ? Phase.STOPPING : Phase.PAUSED;
    if (budget != null) { try { budget.pause(); } catch (IOException expired) { retire(); } }
  }
  synchronized boolean retire() { return retire("policy"); }
  synchronized boolean retire(String reason) {
    if (terminal) return false;
    terminal = true; this.reason = reason; receipt = null; phase = Phase.ENDED; MediaPlaybackReservation.draining(this);
    if (budget != null) budget.cancel();
    if (!network && !decoder) MediaPlaybackReservation.release(this);
    return true;
  }
  synchronized void drained(long token, boolean transport) {
    if (token != attempt) return;
    if (transport) network = false; else if (!uncertain) decoder = false;
    if (!network && !decoder) {
      MediaPlaybackReservation.release(this); retained = null;
      if (!terminal) phase = Phase.PAUSED;
    }
  }
  synchronized LiveMP3Budget budget(long token) throws IOException {
    if (token != attempt || budget == null || terminal) throw new IOException("Stale live budget"); return budget;
  }
  synchronized void uncertainCleanup() {
    uncertain = true; terminal = true; reason = "backend-exited"; receipt = null; phase = Phase.ENDED;
    if (budget != null) budget.cancel();
    MediaPlaybackReservation.uncertain(this);
  }
  synchronized String reason() { return reason; }
  synchronized String takeTerminal() {
    if (!terminal || terminalTaken || (!uncertain && (network || decoder))) return null;
    terminalTaken = true; return reason;
  }
  synchronized boolean drained() { return !network && !decoder; }
  synchronized Phase phase() { return phase; }
}
