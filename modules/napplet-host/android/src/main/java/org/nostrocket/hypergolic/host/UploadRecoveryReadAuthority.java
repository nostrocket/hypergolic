package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** App-only read leases captured from current native host configurations; never reusable PUT authority. */
final class UploadRecoveryReadAuthority {
  private record Context(String generation, String identity) {}
  static final class Lease {
    final UploadRecoveryLedger.Entry record;
    private final Context context;
    private final long epoch, expires;
    private Lease(UploadRecoveryLedger.Entry record, Context context, long epoch, long expires) {
      this.record = record; this.context = context; this.epoch = epoch; this.expires = expires;
    }
  }
  private final LongSupplier clock;
  private final Map<String, Context> contexts = new HashMap<>();
  private final Map<Lease, Boolean> reads = new IdentityHashMap<>();
  private boolean foreground, clockFailed;
  private String identity;
  private long epoch, lastTime = -1;
  UploadRecoveryReadAuthority(LongSupplier clock) { this.clock = clock; }
  synchronized boolean register(String generation, String identity) {
    time();
    if (clockFailed || generation == null || !generation.matches("[A-Za-z0-9_-]{1,80}") || identity == null || !identity.matches("[0-9a-f]{64}") || contexts.containsKey(generation)) return false;
    if (this.identity != null && !this.identity.equals(identity)) { contexts.clear(); invalidate(); }
    if (contexts.size() >= 64) return false;
    this.identity = identity; contexts.put(generation, new Context(generation, identity)); return true;
  }
  synchronized void foreground(boolean value) { time(); foreground = value; if (!value) invalidate(); }
  synchronized void revoke(String generation) {
    Context old = contexts.remove(generation); reads.keySet().removeIf(lease -> lease.context == old);
    if (contexts.isEmpty()) identity = null;
  }
  synchronized String identity() { time(); return foreground && !clockFailed && !contexts.isEmpty() ? identity : null; }
  synchronized Lease capture(UploadRecoveryLedger.Entry record) {
    long now = time(); reads.keySet().removeIf(lease -> !liveAt(lease, now));
    if (identity() == null || record == null || record.state() != UploadRecoveryLedger.State.UNKNOWN || !record.identity().equals(identity) || reads.size() >= 2 ||
      reads.keySet().stream().anyMatch(lease -> lease.record.uploadId().equals(record.uploadId()))) return null;
    Context context = contexts.values().iterator().next();
    Lease lease = new Lease(record, context, epoch, now + 60_000); reads.put(lease, true); return lease;
  }
  synchronized boolean live(Lease lease) { return liveAt(lease, time()); }
  private boolean liveAt(Lease lease, long now) {
    return lease != null && reads.containsKey(lease) && foreground && !clockFailed && lease.epoch == epoch && now < lease.expires &&
      contexts.get(lease.context.generation) == lease.context && lease.record.identity().equals(identity);
  }
  synchronized void cancel(Lease lease) { reads.remove(lease); }
  /** The caller supplies only a fully framed response from the fixed native GET owner. */
  synchronized UploadRecoveryLedger.State finish(Lease lease, int status, byte[] body, UploadRecoveryLedger ledger) throws IOException {
    if (!live(lease)) return UploadRecoveryLedger.State.UNKNOWN;
    reads.remove(lease);
    UploadRecoveryLedger.State state = UploadRecoveryLedger.State.UNKNOWN;
    if (status == 404) state = UploadRecoveryLedger.State.ABSENT;
    else if (status == 200 && body != null && body.length == lease.record.size()) {
      try {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(body); StringBuilder text = new StringBuilder(64);
        for (byte value : hash) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        if (text.toString().equals(lease.record.sha256())) state = UploadRecoveryLedger.State.PRESENT;
      } catch (NoSuchAlgorithmException failed) { throw new IOException("Recovery hash unavailable", failed); }
    }
    return state != UploadRecoveryLedger.State.UNKNOWN && ledger.settle(lease.record, state) ? state : UploadRecoveryLedger.State.UNKNOWN;
  }
  private void invalidate() { reads.clear(); if (epoch == Long.MAX_VALUE) clockFailed = true; else epoch++; }
  private long time() {
    try { long value = clock.getAsLong(); if (value < 0 || value < lastTime || value > Long.MAX_VALUE - 60_000) throw new IllegalStateException(); lastTime = value; return value; }
    catch (RuntimeException failed) { clockFailed = true; invalidate(); return 0; }
  }
}
