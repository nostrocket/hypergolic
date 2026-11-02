package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Synchronous native authority, independent of delayed React Native events.
 * The host validates origin/frame, schema and immutable registration before admission. */
public final class CapabilityLeaseRegistry {
  public static final int MAX_BYTES = 2 * 1024 * 1024;
  private static final int MAX_SESSIONS = 64;
  private static final int MAX_PENDING = 8;
  private static final int MAX_PER_SESSION = 4;
  private static final long MAX_SEQUENCE = 9_007_199_254_740_991L;
  private static final long LIFETIME_MS = 25_000L;
  private final LongSupplier elapsedRealtime;
  private final Map<String, Session> sessions = new HashMap<>();
  private final Map<String, Request> requests = new HashMap<>();
  private boolean foreground = true;

  /** Background invalidates pending work permanently while retaining loaded sessions and replay counters. */
  public synchronized java.util.List<String> setForeground(boolean value) {
    foreground = value;
    if (value) return java.util.List.of();
    java.util.List<String> revoked = new java.util.ArrayList<>(requests.keySet());
    requests.clear();
    return revoked;
  }

  private static final class Session { long sequence = 0; }
  private static final class Request {
    final String generation;
    final String snapshot;
    final long expires;
    boolean claimed = false;
    Request(String generation, String snapshot, long expires) {
      this.generation = generation; this.snapshot = snapshot; this.expires = expires;
    }
  }
  /** Android supplies SystemClock.elapsedRealtime, which includes device sleep. */
  public CapabilityLeaseRegistry(LongSupplier elapsedRealtime) { this.elapsedRealtime = elapsedRealtime; }
  public synchronized boolean register(String generation) {
    if (!identifier(generation) || sessions.containsKey(generation) || sessions.size() >= MAX_SESSIONS) return false;
    sessions.put(generation, new Session()); return true;
  }
  public synchronized boolean sessionActive(String generation) { return sessions.containsKey(generation); }
  public synchronized void revoke(String generation) {
    sessions.remove(generation);
    requests.entrySet().removeIf(entry -> entry.getValue().generation.equals(generation));
  }
  /** Snapshot is a complete JSON string constructed by the host from native registration and the original serialized request. */
  public synchronized String admit(String generation, long sequence, String snapshot) {
    prune();
    if (!consumeSequence(generation, sequence)) return null;
    if (!foreground || snapshot == null || snapshot.length() > MAX_BYTES || snapshot.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES || requests.size() >= MAX_PENDING) return null;
    long ownPending = requests.values().stream().filter(request -> request.generation.equals(generation)).count();
    if (ownPending >= MAX_PER_SESSION) return null;
    long now = elapsedRealtime.getAsLong();
    if (now < 0 || now > Long.MAX_VALUE - LIFETIME_MS) return null;
    String token = UUID.randomUUID().toString();
    requests.put(token, new Request(generation, snapshot, now + LIFETIME_MS));
    return token;
  }
  /** Shared counter for ordinary and approval lanes; rejection still consumes an observed sequence. */
  public synchronized boolean consumeSequence(String generation, long sequence) {
    Session session = sessions.get(generation);
    if (session == null || sequence < 1 || sequence > MAX_SEQUENCE || sequence != session.sequence + 1) return false;
    session.sequence = sequence;
    return true;
  }
  public synchronized String take(String token) {
    prune();
    Request request = requests.get(token);
    if (request == null || request.claimed || !sessions.containsKey(request.generation)) return null;
    request.claimed = true; return request.snapshot;
  }
  public synchronized boolean isActive(String token) {
    prune();
    Request request = requests.get(token);
    return request != null && request.claimed && sessions.containsKey(request.generation);
  }
  /** Read-only native borrowing after the one-use claim; this never grants or extends a lease. */
  public synchronized String borrowedSnapshot(String token) {
    prune();
    Request request = requests.get(token);
    return request != null && request.claimed && sessions.containsKey(request.generation) ? request.snapshot : null;
  }
  /** Consumes exactly this request. Delivery must still recheck its generation on the UI thread. */
  public synchronized boolean finish(String token) {
    prune();
    Request request = requests.remove(token);
    return request != null && request.claimed && sessions.containsKey(request.generation);
  }
  private void prune() {
    long now = elapsedRealtime.getAsLong();
    requests.entrySet().removeIf(entry -> now < 0 || now >= entry.getValue().expires || !sessions.containsKey(entry.getValue().generation));
  }
  private static boolean identifier(String value) { return value != null && value.matches("[A-Za-z0-9_-]{1,80}"); }
}
