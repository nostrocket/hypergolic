package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Process-scoped owner for trusted-shell published artifact HTTPS requests. */
public final class PublishedHttpsRequestOwner {
  private static final int MAX_CONCURRENT_REQUESTS = 4;
  private static final int MAX_PROCESS_OPERATIONS = 65_536;
  private static final int ARTIFACT_CHUNK_BYTES = 48 * 1024;
  private static final int MAX_RESERVED_BODY_BYTES = 32 * 1024 * 1024;
  private static final ScheduledThreadPoolExecutor expiry = new ScheduledThreadPoolExecutor(1, task -> {
    Thread thread = new Thread(task, "napplet-artifact-https-expiry");
    thread.setDaemon(true);
    return thread;
  });
  static { expiry.setRemoveOnCancelPolicy(true); }
  private static final PublishedHttpsTransport.AddressPolicy POLICY = new PublishedHttpsTransport.AddressPolicy() {
    @Override public boolean isAllowedHost(String hostname) {
      return hostname != null && PublishedHttpsTransport.isDnsHostname(hostname.toLowerCase(Locale.ROOT));
    }
    @Override public boolean isAllowedAddress(InetAddress address) {
      return address != null && PublicAddressPolicy.accepts(address.getAddress());
    }
  };
  public static final PublishedHttpsRequestOwner INSTANCE = new PublishedHttpsRequestOwner();

  static PublishedHttpsTransport.AddressPolicy addressPolicy() { return POLICY; }

  public interface JobState { boolean isActive(); }
  interface Fetcher { byte[] fetch(String url, PublishedHttpsTransport.Cancellation cancellation) throws IOException; }

  private final Object lock = new Object();
  private final Map<String, Operation> active = new HashMap<>();
  // Operation ids are one-use for this process lifetime, including completed and cancelled requests.
  private final Set<String> consumed = new HashSet<>();
  private final Fetcher fetcher, artifactFetcher;
  private boolean foreground;

  public PublishedHttpsRequestOwner() {
    this((url, cancellation) -> PublishedHttpsTransport.get(url, POLICY, cancellation),
        (url, cancellation) -> PublishedHttpsTransport.getArtifact(url, POLICY, cancellation));
  }

  PublishedHttpsRequestOwner(Fetcher fetcher) { this(fetcher, fetcher); }

  PublishedHttpsRequestOwner(Fetcher fetcher, Fetcher artifactFetcher) {
    if (fetcher == null || artifactFetcher == null) throw new IllegalArgumentException("Missing HTTPS fetcher");
    this.fetcher = fetcher;
    this.artifactFetcher = artifactFetcher;
  }

  public void setForeground(boolean value) {
    synchronized (lock) {
      foreground = value;
      if (!value) cancelActiveLocked();
    }
  }

  private Operation begin(String operationId, int maximumBytes) throws IOException {
    validateOperationId(operationId);
    Operation operation = new Operation(maximumBytes);
    synchronized (lock) {
      if (!foreground) throw new IOException("Published HTTPS transport is inactive");
      if (consumed.contains(operationId)) throw new IOException("Published HTTPS operation id was already used");
      if (active.size() >= MAX_CONCURRENT_REQUESTS) throw new IOException("Too many published HTTPS requests");
      if (consumed.size() >= MAX_PROCESS_OPERATIONS) throw new IOException("Published HTTPS operation limit reached");
      int reserved = maximumBytes;
      for (Operation existing : active.values()) reserved += existing.reservedBytes();
      if (reserved > MAX_RESERVED_BODY_BYTES) throw new IOException("Published HTTPS body budget exhausted");
      consumed.add(operationId);
      active.put(operationId, operation);
    }
    return operation;
  }

  public byte[] fetch(String operationId, String url, JobState job) throws IOException {
    Operation operation = begin(operationId, PublishedHttpsTransport.MAX_BODY_BYTES);
    try {
      return fetcher.fetch(url, () -> operation.cancelled || job == null || !job.isActive());
    } finally {
      synchronized (lock) { active.remove(operationId, operation); }
    }
  }

  /** Starts the artifact transport and retains at most one bounded body for sequential app-only reads. */
  public int fetchArtifact(String operationId, String url, JobState job) throws IOException {
    Operation operation = begin(operationId, PublishedHttpsTransport.MAX_ARTIFACT_BYTES);
    byte[] bytes = null;
    try {
      bytes = artifactFetcher.fetch(url, () -> operation.cancelled || job == null || !job.isActive());
      synchronized (lock) {
        if (!foreground || active.get(operationId) != operation || operation.cancelled || job == null || !job.isActive() ||
            bytes == null || bytes.length < 1 || bytes.length > PublishedHttpsTransport.MAX_ARTIFACT_BYTES) {
          throw new IOException("Published artifact download unavailable");
        }
        operation.bytes = bytes;
        operation.expiry = expiry.schedule(() -> cancel(operationId), 15, TimeUnit.SECONDS);
        return bytes.length;
      }
    } finally {
      synchronized (lock) {
        if (operation.expiry == null) {
          active.remove(operationId, operation);
          if (bytes != null) Arrays.fill(bytes, (byte) 0);
        }
      }
    }
  }

  public byte[] readArtifactChunk(String operationId, int offset) throws IOException {
    synchronized (lock) {
      Operation operation = active.get(operationId);
      if (!foreground || operation == null || operation.cancelled || operation.bytes == null ||
          offset != operation.cursor || offset < 0 || offset >= operation.bytes.length) {
        throw new IOException("Invalid published artifact download cursor");
      }
      int end = Math.min(operation.bytes.length, offset + ARTIFACT_CHUNK_BYTES);
      byte[] chunk = Arrays.copyOfRange(operation.bytes, offset, end);
      operation.cursor = end;
      if (end == operation.bytes.length) {
        active.remove(operationId);
        operation.clear();
      }
      return chunk;
    }
  }

  public boolean cancel(String operationId) {
    if (!isCanonicalUuid(operationId)) return false;
    synchronized (lock) {
      Operation operation = active.get(operationId);
      if (operation != null) {
        operation.cancelled = true;
        if (operation.bytes != null) {
          active.remove(operationId);
          operation.clear();
        }
        return true;
      }
      // Record a cancel that beats Expo's async coroutine registration. Marking it consumed
      // makes the later fetch reject without retaining a separate unbounded tombstone set.
      if (consumed.contains(operationId) || consumed.size() >= MAX_PROCESS_OPERATIONS) return false;
      consumed.add(operationId);
      return true;
    }
  }

  public void revokeAll() {
    synchronized (lock) { cancelActiveLocked(); }
  }

  public static boolean isCanonicalUuid(String value) {
    if (value == null || value.length() != 36) return false;
    try { return UUID.fromString(value).toString().equals(value); }
    catch (IllegalArgumentException ignored) { return false; }
  }

  private static void validateOperationId(String value) throws IOException {
    if (!isCanonicalUuid(value)) throw new IOException("Invalid published HTTPS operation id");
  }

  private void cancelActiveLocked() {
    active.values().removeIf(operation -> {
      operation.cancelled = true;
      if (operation.bytes == null) return false;
      operation.clear();
      return true;
    });
  }

  private static final class Operation {
    final int maximumBytes;
    volatile boolean cancelled;
    byte[] bytes;
    Operation(int maximumBytes) { this.maximumBytes = maximumBytes; }
    int reservedBytes() { return bytes == null ? maximumBytes : bytes.length; }
    int cursor;
    ScheduledFuture<?> expiry;
    void clear() {
      if (bytes != null) Arrays.fill(bytes, (byte) 0);
      bytes = null;
      if (expiry != null) expiry.cancel(false);
    }
  }
}
