package org.nostrocket.hypergolic.signercore;

import java.util.HashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/** Public BIP340 math only. Slots survive cancellation until execution actually unwinds. */
final class NativePublicVerification {
  interface Verifier { boolean verify(String publicKey, byte[] digest, String signature); }
  private static final Object LOCK = new Object();
  private static final Map<String, Job> JOBS = new HashMap<>();
  private final Map<String, Long> cancelled = new HashMap<>();
  private final LongSupplier clock;
  private final Verifier verifier;
  private boolean closed, foreground = true;
  private long denyUntil, revision;
  static final class Job {
    final NativePublicVerification owner;
    final String id, raw;
    final long expires, revision;
    final BooleanSupplier active;
    boolean cancelled, started;
    Job(NativePublicVerification owner, String id, String raw, long expires, BooleanSupplier active) {
      this.owner = owner; this.id = id; this.raw = raw; this.expires = expires; this.active = active; this.revision = owner.revision;
    }
  }
  NativePublicVerification() { this(System::nanoTime, NativeSigningKey::verify); }
  NativePublicVerification(LongSupplier clock, Verifier verifier) { this.clock = clock; this.verifier = verifier; }
  private static IllegalStateException denied() { return new IllegalStateException("PUBLIC_VERIFY_DENIED"); }
  private static boolean uuid(String value) {
    return value != null && value.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  }
  Job begin(String id, String raw, double milliseconds, BooleanSupplier active) {
    if (!uuid(id) || raw == null || raw.length() > 65_536 || raw.isEmpty() ||
        !Double.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 15_000 || milliseconds % 1 != 0) throw denied();
    for (int i = 0; i < raw.length(); i++) if (raw.charAt(i) > 127) throw denied();
    if (!active.getAsBoolean()) throw denied();
    synchronized (LOCK) {
      long now = clock.getAsLong();
      cancelled.entrySet().removeIf(row -> row.getValue() <= now);
      if (closed || !foreground || now < denyUntil || cancelled.containsKey(id) || JOBS.size() >= 2 || JOBS.containsKey(id)) throw denied();
      Job job = new Job(this, id, raw, now + (long)milliseconds * 1_000_000, active);
      JOBS.put(id, job);
      return job;
    }
  }
  void delivery(Job job) {
    if (!job.active.getAsBoolean()) throw denied();
    synchronized (LOCK) {
      if (closed || !foreground || job.revision != revision || job.cancelled || clock.getAsLong() < denyUntil || cancelled.containsKey(job.id) || clock.getAsLong() >= job.expires) throw denied();
    }
  }
  private void check(Job job) {
    if (!job.active.getAsBoolean()) throw denied();
    synchronized (LOCK) {
      if (closed || !foreground || job.revision != revision || job.cancelled || JOBS.get(job.id) != job || clock.getAsLong() >= job.expires) throw denied();
    }
  }
  String run(Job job) {
    synchronized (LOCK) {
      if (job.owner != this || JOBS.get(job.id) != job || job.started) throw denied();
      job.started = true;
    }
    try {
      check(job);
      Cursor cursor = new Cursor(job.raw);
      StringBuilder results = new StringBuilder();
      cursor.take('[');
      int count = 0;
      do {
        check(job);
        if (++count > 200) throw denied();
        cursor.take('[');
        String pubkey = cursor.hex(64); cursor.take(',');
        String digest = cursor.hex(64); cursor.take(',');
        String signature = cursor.hex(128); cursor.take(']');
        boolean valid = verifier.verify(pubkey, decode(digest), signature);
        check(job);
        if (count > 1) results.append(',');
        results.append(valid);
      } while (cursor.more());
      check(job);
      return "{\"operationId\":\"" + job.id + "\",\"results\":[" + results + "]}";
    } finally {
      synchronized (LOCK) { if (JOBS.get(job.id) == job) JOBS.remove(job.id); }
    }
  }
  /** A dispatch that never entered run may be discarded; a later run cannot claim it. */
  void abandon(Job job) {
    synchronized (LOCK) {
      job.cancelled = true;
      if (!job.started && JOBS.get(job.id) == job) JOBS.remove(job.id);
    }
  }
  void cancel(String id) {
    if (!uuid(id)) return;
    synchronized (LOCK) {
      Job job = JOBS.get(id);
      if (job != null && job.owner == this) { job.cancelled = true; return; }
      long now = clock.getAsLong();
      cancelled.entrySet().removeIf(row -> row.getValue() <= now);
      // Bounded pre-admission cancellation, including async bridge dispatch races.
      if (cancelled.size() >= 64) denyUntil = now + 15_000_000_000L;
      else cancelled.put(id, now + 15_000_000_000L);
    }
  }
  void foreground(boolean value) {
    synchronized (LOCK) {
      foreground = value;
      if (!value) {
        revision++;
        for (Job job : JOBS.values()) if (job.owner == this) job.cancelled = true;
      }
    }
  }
  void close() {
    synchronized (LOCK) { closed = true; }
    foreground(false);
  }
  private static byte[] decode(String hex) {
    byte[] output = new byte[32];
    for (int i = 0; i < 32; i++) output[i] = (byte)Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return output;
  }
  private static final class Cursor {
    final String raw;
    int at;
    Cursor(String raw) { this.raw = raw; }
    void take(char expected) { if (at >= raw.length() || raw.charAt(at++) != expected) throw denied(); }
    String hex(int size) {
      take('"');
      if (at + size >= raw.length()) throw denied();
      String value = raw.substring(at, at + size);
      if (!value.matches("[0-9a-f]{" + size + "}")) throw denied();
      at += size; take('"'); return value;
    }
    boolean more() {
      if (at >= raw.length()) throw denied();
      if (raw.charAt(at) == ',') { at++; return true; }
      take(']'); if (at != raw.length()) throw denied(); return false;
    }
  }
}
