package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Process-scoped owner for trusted-shell initial relay lookups. */
public final class PublishedRelayWssRequestOwner {
  private static final int MAX_CONCURRENT = 4;
  private static final int MAX_OPERATIONS = 65_536;
  private static final PublishedHttpsTransport.AddressPolicy POLICY = PublishedHttpsRequestOwner.addressPolicy();
  public static final PublishedRelayWssRequestOwner INSTANCE = new PublishedRelayWssRequestOwner(
      (url, request, subscriptionId, cancellation) -> PublishedRelayWssQuery.query(
          url, request, POLICY, cancellation, new PublishedRelayResponseClassifier(subscriptionId)));

  interface Query { List<String> run(String url, String request, String subscriptionId,
      PublishedHttpsTransport.Cancellation cancellation) throws IOException; }
  public interface JobState { boolean isActive(); }

  private final Object lock = new Object();
  private final Map<String, Operation> active = new HashMap<>();
  private final Set<String> consumed = new HashSet<>();
  private final Query query;
  private volatile boolean foreground;

  public PublishedRelayWssRequestOwner() { this((url, request, subscriptionId, cancellation) ->
      PublishedRelayWssQuery.query(url, request, POLICY, cancellation,
          new PublishedRelayResponseClassifier(subscriptionId))); }
  PublishedRelayWssRequestOwner(Query query) {
    if (query == null) throw new IllegalArgumentException("Missing relay query");
    this.query = query;
  }

  public void setForeground(boolean value) {
    synchronized (lock) {
      foreground = value;
      if (!value) cancelActiveLocked();
    }
  }

  public List<String> query(String operationId, String url, String request, String subscriptionId, JobState job)
      throws IOException {
    if (!isCanonicalUuid(operationId)) throw new IOException("Invalid relay operation id");
    if (subscriptionId == null || !subscriptionId.matches("[A-Za-z0-9_-]{1,64}")) {
      throw new IOException("Invalid relay subscription id");
    }
    PublishedRelayResponseClassifier.validateRequest(request, subscriptionId);
    Operation operation = new Operation();
    synchronized (lock) {
      if (!foreground) throw new IOException("Published relay transport is inactive");
      if (consumed.contains(operationId)) throw new IOException("Relay operation id was already used");
      if (active.size() >= MAX_CONCURRENT) throw new IOException("Too many published relay requests");
      if (consumed.size() >= MAX_OPERATIONS) throw new IOException("Published relay operation limit reached");
      consumed.add(operationId);
      active.put(operationId, operation);
    }
    try {
      List<String> result = query.run(url, request, subscriptionId, () ->
          operation.cancelled || !foreground || !isJobActive(job));
      ensureLive(operationId, operation, job);
      if (result == null || result.isEmpty() || result.size() > PublishedRelayWssQuery.MAX_TEXT_MESSAGES) {
        throw new IOException("Invalid published relay result");
      }
      return Collections.unmodifiableList(result);
    } finally {
      synchronized (lock) { active.remove(operationId, operation); }
    }
  }

  public boolean cancel(String operationId) {
    if (!isCanonicalUuid(operationId)) return false;
    synchronized (lock) {
      Operation operation = active.get(operationId);
      if (operation != null) { operation.cancelled = true; return true; }
      if (consumed.contains(operationId) || consumed.size() >= MAX_OPERATIONS) return false;
      consumed.add(operationId); // A cancellation that beats coroutine registration is one-use too.
      return true;
    }
  }

  public void revokeAll() { synchronized (lock) { cancelActiveLocked(); } }

  public static boolean isCanonicalUuid(String value) {
    if (value == null || value.length() != 36) return false;
    try { return UUID.fromString(value).toString().equals(value); }
    catch (IllegalArgumentException ignored) { return false; }
  }

  private void ensureLive(String id, Operation operation, JobState job) throws IOException {
    synchronized (lock) {
      if (!foreground || active.get(id) != operation || operation.cancelled || !isJobActive(job)) {
        throw new IOException("Published relay result was revoked");
      }
    }
  }
  private static boolean isJobActive(JobState job) {
    if (job == null) return false;
    try { return job.isActive(); } catch (RuntimeException unavailable) { return false; }
  }
  private void cancelActiveLocked() { for (Operation operation : active.values()) operation.cancelled = true; }
  private static final class Operation { volatile boolean cancelled; }
}
