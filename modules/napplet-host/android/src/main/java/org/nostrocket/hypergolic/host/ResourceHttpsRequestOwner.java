package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** App-only resource reads. Native lease guards remain authoritative during fetch and chunk delivery. */
public final class ResourceHttpsRequestOwner {
  public static final int MAX_BYTES = 10 * 1024 * 1024;
  public static final int CHUNK_BYTES = 256 * 1024;
  public interface Active { boolean isActive(); }
  interface Fetcher { byte[] fetch(String url, PublishedHttpsTransport.Cancellation cancellation) throws IOException; }
  public static final class Failure extends IOException {
    private static final long serialVersionUID = 1L;
    public final String code;
    Failure(String code) { super(code); this.code = code; }
  }
  public static final ResourceHttpsRequestOwner INSTANCE = new ResourceHttpsRequestOwner(
      (url, cancelled) -> PublishedHttpsTransport.getResource(url, PublishedHttpsRequestOwner.addressPolicy(), cancelled));
  private static final class Operation {
    final String token, generation;
    final Active lease;
    volatile boolean cancelled;
    byte[] bytes;
    int cursor;
    Operation(String token, String generation, Active lease) { this.token = token; this.generation = generation; this.lease = lease; }
  }
  private final Object lock = new Object();
  private final Map<String, Operation> operations = new HashMap<>();
  private final Set<String> used = new HashSet<>();
  private final Fetcher fetcher;
  private boolean foreground;
  ResourceHttpsRequestOwner(Fetcher fetcher) { this.fetcher = fetcher; }
  public void setForeground(boolean value) {
    synchronized (lock) { foreground = value; if (!value) revokeAllLocked(); }
  }
  public int fetch(String id, String token, String generation, String url, Active lease, Active job) throws IOException {
    if (!validId(id) || token == null || generation == null || lease == null || job == null) throw new Failure("invalid-request");
    final Operation operation = new Operation(token, generation, lease);
    synchronized (lock) {
      pruneLocked();
      if (!foreground || !lease.isActive()) throw new Failure("blocked-by-policy");
      if (used.contains(id)) throw new Failure("invalid-request");
      if (operations.size() >= 4 || used.size() >= 65_536) throw new Failure("quota-exceeded");
      used.add(id); operations.put(id, operation);
    }
    try {
      byte[] body = fetcher.fetch(url, () -> operation.cancelled || !lease.isActive() || !job.isActive());
      synchronized (lock) {
        if (!foreground || operations.get(id) != operation || operation.cancelled || !lease.isActive() || !job.isActive()) throw new Failure("timeout");
        if (body == null || body.length > MAX_BYTES) throw new Failure("too-large");
        operation.bytes = body;
        return body.length;
      }
    } catch (IOException error) {
      cancel(id);
      if (error instanceof Failure) throw error;
      if (error instanceof PublishedHttpsResponseReader.ResourceFailure) throw new Failure(((PublishedHttpsResponseReader.ResourceFailure) error).code);
      if (error instanceof SocketTimeoutException) throw new Failure("timeout");
      if (!lease.isActive() || !job.isActive()) throw new Failure("timeout");
      // Native URL and address policy is independently checked before any connection.
      throw new Failure("network-error");
    }
  }
  /** Exact cursor plus captured lease; chunks cannot be reordered, replayed or borrowed by another request. */
  public byte[] read(String id, String token, int offset) throws IOException {
    synchronized (lock) {
      pruneLocked();
      Operation operation = operations.get(id);
      if (!foreground || operation == null || !operation.token.equals(token) || operation.cancelled ||
          !operation.lease.isActive()) throw new Failure("blocked-by-policy");
      if (operation.bytes == null || offset != operation.cursor || offset < 0 || offset >= operation.bytes.length) throw new Failure("invalid-request");
      int end = Math.min(operation.bytes.length, offset + CHUNK_BYTES);
      byte[] chunk = Arrays.copyOfRange(operation.bytes, offset, end);
      operation.cursor = end;
      if (end == operation.bytes.length) { operations.remove(id); operation.bytes = null; }
      return chunk;
    }
  }
  public void cancel(String id) {
    if (!validId(id)) return;
    synchronized (lock) {
      if (used.size() < 65_536) used.add(id);
      Operation operation = operations.remove(id);
      if (operation != null) { operation.cancelled = true; operation.bytes = null; }
    }
  }
  public void revokeGeneration(String generation) {
    synchronized (lock) {
      operations.entrySet().removeIf(entry -> {
        Operation value = entry.getValue();
        if (!value.generation.equals(generation)) return false;
        value.cancelled = true; value.bytes = null; return true;
      });
    }
  }
  public void revokeAll() { synchronized (lock) { revokeAllLocked(); } }
  private void revokeAllLocked() {
    for (Operation operation : operations.values()) { operation.cancelled = true; operation.bytes = null; }
    operations.clear();
  }
  private void pruneLocked() {
    operations.entrySet().removeIf(entry -> {
      Operation value = entry.getValue();
      if (value.lease.isActive()) return false;
      value.cancelled = true; value.bytes = null; return true;
    });
  }
  private static boolean validId(String id) {
    if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) return false;
    try { return UUID.fromString(id).toString().equals(id); } catch (IllegalArgumentException invalid) { return false; }
  }
}
