package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.function.Predicate;

/** Native generation authority for read streams; admission is short, accepted intent is generation-lived. */
public final class RelaySubscriptionRegistry {
  public static final int MAX_SNAPSHOT_BYTES = 32 * 1024;
  private static final int MAX_STREAMS = 8;
  private static final int MAX_PER_GENERATION = 2;
  private static final long ADMISSION_MS = 25_000;
  private final LongSupplier now;
  private final Predicate<String> generationActive;
  private final Map<String, Stream> streams = new HashMap<>();
  private boolean foreground;
  private static final class Stream {
    final String generation;
    final String snapshot;
    final long expires;
    final boolean outbox;
    boolean claimed;
    boolean accepted;
    Stream(String generation, String snapshot, long expires, boolean outbox) {
      this.generation = generation; this.snapshot = snapshot; this.expires = expires; this.outbox = outbox;
    }
  }
  public RelaySubscriptionRegistry(LongSupplier now, Predicate<String> generationActive) {
    if (now == null || generationActive == null) throw new IllegalArgumentException("Missing authority");
    this.now = now; this.generationActive = generationActive;
  }
  public synchronized void setForeground(boolean value) { foreground = value; }
  /** Caller must first consume the native host's shared transport sequence. */
  public synchronized String admit(String generation, String snapshot) { return admit(generation, snapshot, false); }
  public synchronized String admit(String generation, String snapshot, boolean outbox) {
    prune();
    long clock = now.getAsLong();
    if (!foreground || !activeGeneration(generation) || snapshot == null || snapshot.length() > MAX_SNAPSHOT_BYTES ||
        snapshot.getBytes(StandardCharsets.UTF_8).length > MAX_SNAPSHOT_BYTES || streams.size() >= MAX_STREAMS ||
        clock < 0 || clock > Long.MAX_VALUE - ADMISSION_MS) return null;
    long own = streams.values().stream().filter(stream -> stream.generation.equals(generation)).count();
    if (own >= MAX_PER_GENERATION) return null;
    String token = UUID.randomUUID().toString();
    streams.put(token, new Stream(generation, snapshot, clock + ADMISSION_MS, outbox));
    return token;
  }
  public synchronized String take(String token) {
    prune(); Stream stream = streams.get(token);
    if (stream == null || stream.claimed) return null;
    stream.claimed = true; return stream.snapshot;
  }
  public synchronized boolean accept(String token) {
    prune(); Stream stream = streams.get(token);
    if (!foreground || stream == null || !stream.claimed || stream.accepted) return false;
    stream.accepted = true; return true;
  }
  public synchronized boolean isActive(String token) {
    prune(); Stream stream = streams.get(token);
    return stream != null && stream.claimed && stream.accepted;
  }
  public synchronized int connectionLimit(String token) {
    prune(); Stream stream = streams.get(token);
    return stream != null && stream.claimed && stream.accepted ? (stream.outbox ? 16 : 2) : 0;
  }
  public synchronized boolean mayDeliver(String token) { return foreground && isActive(token); }
  public synchronized void close(String token) { streams.remove(token); }
  public synchronized void revoke(String generation) { streams.entrySet().removeIf(entry -> entry.getValue().generation.equals(generation)); }
  public synchronized void revokeAll() { streams.clear(); }
  private boolean activeGeneration(String generation) {
    if (generation == null || !generation.matches("[A-Za-z0-9_-]{1,80}")) return false;
    try { return generationActive.test(generation); } catch (RuntimeException unavailable) { return false; }
  }
  private void prune() {
    long clock = now.getAsLong();
    streams.entrySet().removeIf(entry -> clock < 0 || !activeGeneration(entry.getValue().generation) ||
        !entry.getValue().accepted && clock >= entry.getValue().expires);
  }
}
