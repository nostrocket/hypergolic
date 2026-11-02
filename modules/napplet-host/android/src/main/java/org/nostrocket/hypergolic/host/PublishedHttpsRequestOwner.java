package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Process-scoped owner for trusted-shell published artifact HTTPS requests. */
public final class PublishedHttpsRequestOwner {
  private static final int MAX_CONCURRENT_REQUESTS = 4;
  private static final int MAX_PROCESS_OPERATIONS = 65_536;
  private static final PublishedHttpsTransport.AddressPolicy POLICY = new PublishedHttpsTransport.AddressPolicy() {
    @Override public boolean isAllowedHost(String hostname) {
      return hostname != null && PublishedHttpsTransport.isDnsHostname(hostname.toLowerCase(Locale.ROOT));
    }
    @Override public boolean isAllowedAddress(InetAddress address) {
      return address != null && PublicAddressPolicy.accepts(address.getAddress());
    }
  };
  public static final PublishedHttpsRequestOwner INSTANCE = new PublishedHttpsRequestOwner(
      (url, cancellation) -> PublishedHttpsTransport.get(url, POLICY, cancellation));

  static PublishedHttpsTransport.AddressPolicy addressPolicy() { return POLICY; }

  public interface JobState { boolean isActive(); }
  interface Fetcher { byte[] fetch(String url, PublishedHttpsTransport.Cancellation cancellation) throws IOException; }

  private final Object lock = new Object();
  private final Map<String, Operation> active = new HashMap<>();
  // Operation ids are one-use for this process lifetime, including completed and cancelled requests.
  private final Set<String> consumed = new HashSet<>();
  private final Fetcher fetcher;
  private boolean foreground;

  public PublishedHttpsRequestOwner() { this((url, cancellation) -> PublishedHttpsTransport.get(url, POLICY, cancellation)); }

  PublishedHttpsRequestOwner(Fetcher fetcher) {
    if (fetcher == null) throw new IllegalArgumentException("Missing HTTPS fetcher");
    this.fetcher = fetcher;
  }

  public void setForeground(boolean value) {
    synchronized (lock) {
      foreground = value;
      if (!value) cancelActiveLocked();
    }
  }

  public byte[] fetch(String operationId, String url, JobState job) throws IOException {
    validateOperationId(operationId);
    Operation operation = new Operation();
    synchronized (lock) {
      if (!foreground) throw new IOException("Published HTTPS transport is inactive");
      if (consumed.contains(operationId)) throw new IOException("Published HTTPS operation id was already used");
      if (active.size() >= MAX_CONCURRENT_REQUESTS) throw new IOException("Too many published HTTPS requests");
      if (consumed.size() >= MAX_PROCESS_OPERATIONS) throw new IOException("Published HTTPS operation limit reached");
      consumed.add(operationId);
      active.put(operationId, operation);
    }
    try {
      return fetcher.fetch(url, () -> operation.cancelled || job == null || !job.isActive());
    } finally {
      synchronized (lock) { active.remove(operationId, operation); }
    }
  }

  public boolean cancel(String operationId) {
    if (!isCanonicalUuid(operationId)) return false;
    synchronized (lock) {
      Operation operation = active.get(operationId);
      if (operation != null) {
        operation.cancelled = true;
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
    for (Operation operation : active.values()) operation.cancelled = true;
  }

  private static final class Operation { volatile boolean cancelled; }
}
