package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
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
  private static final int MAX_WAITING = 16;
  private static final int MAX_WAITING_PER_SESSION = 8;
  private static final long MAX_SEQUENCE = 9_007_199_254_740_991L;
  private static final long LIFETIME_MS = 25_000L;
  private final LongSupplier elapsedRealtime;
  private final Map<String, Session> sessions = new HashMap<>();
  private final Map<String, Request> requests = new HashMap<>();
  private final Map<String, Request> waiting = new LinkedHashMap<>();
  private boolean foreground = true;

  /** Background invalidates pending work permanently while retaining loaded sessions and replay counters. */
  public synchronized List<String> setForeground(boolean value) {
    foreground = value;
    if (value) return List.of();
    List<String> revoked = new ArrayList<>(requests.keySet());
    revoked.addAll(waiting.keySet());
    requests.clear();
    waiting.clear();
    return revoked;
  }

  private static final class Session { long sequence = 0; }
  private static final class Request {
    final String generation;
    final String snapshot;
    final long expires;
    final int waitingBytes;
    boolean claimed = false;
    Request(String generation, String snapshot, long expires, int waitingBytes) {
      this.generation = generation; this.snapshot = snapshot; this.expires = expires; this.waitingBytes = waitingBytes;
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
    waiting.entrySet().removeIf(entry -> entry.getValue().generation.equals(generation));
  }
  /** Snapshot is a complete JSON string constructed by the host from native registration and the original serialized request. */
  public synchronized String admit(String generation, long sequence, String snapshot) {
    return admit(generation, sequence, snapshot, LIFETIME_MS);
  }
  synchronized String admitPublishedOpen(String generation, long sequence, String snapshot) {
    return admit(generation, sequence, snapshot, 120_000L);
  }
  private String admit(String generation, long sequence, String snapshot, long lifetimeMs) {
    prune();
    if (!consumeSequence(generation, sequence)) return null;
    if (!foreground || !canAdmit(generation) || snapshot == null || snapshot.length() > MAX_BYTES ||
        snapshot.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) return null;
    long now = elapsedRealtime.getAsLong();
    if (now < 0 || now > Long.MAX_VALUE - lifetimeMs) return null;
    String token = UUID.randomUUID().toString();
    requests.put(token, new Request(generation, snapshot, now + lifetimeMs, 0));
    return token;
  }
  /** A waiting ID cannot be taken or authorize an effect before promotion. */
  public synchronized String enqueue(String generation, long sequence, String snapshot) {
    prune();
    if (!consumeSequence(generation, sequence)) return null;
    if (!foreground || snapshot == null || snapshot.length() > MAX_BYTES || waiting.size() >= MAX_WAITING ||
        waiting.values().stream().filter(request -> request.generation.equals(generation)).count() >= MAX_WAITING_PER_SESSION) return null;
    int bytes = snapshot.getBytes(StandardCharsets.UTF_8).length;
    if (bytes > MAX_BYTES - waiting.values().stream().mapToInt(request -> request.waitingBytes).sum()) return null;
    long now = elapsedRealtime.getAsLong();
    if (now < 0 || now > Long.MAX_VALUE - LIFETIME_MS) return null;
    String token = UUID.randomUUID().toString();
    waiting.put(token, new Request(generation, snapshot, now + LIFETIME_MS, bytes));
    return token;
  }
  public synchronized List<String> promote() {
    prune();
    List<String> promoted = new ArrayList<>();
    if (!foreground) return promoted;
    Iterator<Map.Entry<String, Request>> entries = waiting.entrySet().iterator();
    while (entries.hasNext() && requests.size() < MAX_PENDING) {
      Map.Entry<String, Request> entry = entries.next();
      Request request = entry.getValue();
      if (!canAdmit(request.generation)) continue;
      String token = entry.getKey();
      entries.remove();
      requests.put(token, request);
      promoted.add(token);
    }
    return promoted;
  }
  public synchronized boolean retained(String token) {
    prune();
    return requests.containsKey(token) || waiting.containsKey(token);
  }
  private boolean canAdmit(String generation) {
    return requests.size() < MAX_PENDING &&
        requests.values().stream().filter(request -> request.generation.equals(generation)).count() < MAX_PER_SESSION;
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
    requests.values().removeIf(request -> expired(request, now));
    waiting.values().removeIf(request -> expired(request, now));
  }
  private boolean expired(Request request, long now) {
    return now < 0 || now >= request.expires || !sessions.containsKey(request.generation);
  }
  private static boolean identifier(String value) { return value != null && value.matches("[A-Za-z0-9_-]{1,80}"); }
}
