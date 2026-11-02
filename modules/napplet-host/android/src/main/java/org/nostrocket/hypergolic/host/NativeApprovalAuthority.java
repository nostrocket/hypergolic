package org.nostrocket.hypergolic.host;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/** Native-only approval lifetime. The host must validate source and transport sequence before admission.
 * Handles stay native; this core does not expose a signer, bridge operation or network effect. */
public final class NativeApprovalAuthority {
  public static final long LIFETIME_MS = 600_000L;
  public static final int MAX_BYTES = 2 * 1024 * 1024;
  private static final int MAX_SESSIONS = 64;
  private static final int MAX_REQUESTS = 16;
  private static final int MAX_PER_SESSION = 4;

  public static final class SessionHandle {
    private final String generation;
    private SessionHandle(String generation) { this.generation = generation; }
  }
  public static final class RequestHandle { private RequestHandle() {} }
  public static final class ApprovalHandle {
    private final RequestHandle request;
    private ApprovalHandle(RequestHandle request) { this.request = request; }
  }
  public static final class Review {
    public final RequestHandle request;
    public final SessionHandle session;
    public final String snapshot;
    private Review(RequestHandle request, Request value) {
      this.request = request; session = value.session; snapshot = value.snapshot;
    }
  }
  public static final class Expiration {
    public final RequestHandle request;
    public final ApprovalHandle approval;
    private Expiration(RequestHandle request, ApprovalHandle approval) {
      this.request = request; this.approval = approval;
    }
  }
  private static final class Request {
    final SessionHandle session;
    final String snapshot;
    final long expires;
    boolean taken;
    Request(SessionHandle session, String snapshot, long expires) {
      this.session = session; this.snapshot = snapshot; this.expires = expires;
    }
  }

  private final LongSupplier elapsedRealtime;
  private final Map<String, SessionHandle> sessions = new HashMap<>();
  private final LinkedHashMap<RequestHandle, Request> requests = new LinkedHashMap<>();
  private SessionHandle focused;
  private ApprovalHandle approved;
  private NativeSigningHold handoff;
  private boolean foreground;
  private boolean paused;
  private boolean clockFailed;
  private long lastTime = -1;

  /** Owning Android composition supplies SystemClock.elapsedRealtime (including device sleep).
   * Unit tests supply an explicit clock double. No JavaScript-selected clock is admitted. */
  public NativeApprovalAuthority(LongSupplier elapsedRealtime) { this.elapsedRealtime = elapsedRealtime; }

  public synchronized SessionHandle register(String generation) {
    prune();
    if (clockFailed || generation == null || !generation.matches("[A-Za-z0-9_-]{1,80}") ||
        sessions.containsKey(generation) || sessions.size() >= MAX_SESSIONS) return null;
    SessionHandle handle = new SessionHandle(generation);
    sessions.put(generation, handle);
    return handle;
  }
  public synchronized void teardown(SessionHandle session) {
    prune();
    if (!registered(session)) return;
    sessions.remove(session.generation);
    if (focused == session) focused = null;
    requests.entrySet().removeIf(entry -> entry.getValue().session == session);
    if (approved != null && !requests.containsKey(approved.request)) { approved = null; handoff = null; }
  }
  public synchronized void setForeground(boolean value) {
    prune();
    foreground = value;
    if (value) { if (handoff != null) handoff.foreground(); }
    else {
      paused = true;
      if (handoff != null) handoff.background();
      if (!handoffRetained()) revokeApproved();
    }
  }
  public synchronized void setFocused(SessionHandle session) {
    prune();
    if (session != null && !registered(session)) return;
    SessionHandle next = session;
    if (focused != next) revokeApproved();
    focused = next;
  }
  /** A late deactivation from an old view cannot clear a replacement view's focus. */
  public synchronized boolean clearFocused(SessionHandle session) {
    prune();
    if (session == null || focused != session) return false;
    revokeApproved(); focused = null;
    return true;
  }
  public synchronized RequestHandle admit(SessionHandle session, String snapshot) {
    prune();
    if (clockFailed || !registered(session) || snapshot == null || snapshot.isEmpty() || snapshot.length() > MAX_BYTES ||
        snapshot.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES || requests.size() >= MAX_REQUESTS ||
        requests.values().stream().filter(request -> request.session == session).count() >= MAX_PER_SESSION ||
        lastTime > Long.MAX_VALUE - LIFETIME_MS) return null;
    RequestHandle handle = new RequestHandle();
    requests.put(handle, new Request(session, snapshot, lastTime + LIFETIME_MS));
    return handle;
  }
  public synchronized Review currentReview() { prune(); return review(); }
  public synchronized ApprovalHandle approve(RequestHandle handle) {
    prune();
    Review current = review();
    if (current == null || current.request != handle) return null;
    approved = new ApprovalHandle(handle);
    return approved;
  }
  public synchronized String take(ApprovalHandle handle) {
    prune();
    if (!validApproval(handle)) return null;
    Request request = requests.get(handle.request);
    if (request.taken) return null;
    request.taken = true;
    return request.snapshot;
  }
  public synchronized boolean isApproved(ApprovalHandle handle) { prune(); return validApproval(handle); }
  public synchronized void finish(ApprovalHandle handle) {
    prune();
    if (handle != null && approved == handle) revokeApproved();
  }
  public synchronized void cancel(RequestHandle handle) {
    prune();
    requests.remove(handle);
    if (approved != null && approved.request == handle) { approved = null; handoff = null; }
  }
  public synchronized void cancel(ApprovalHandle handle) { finish(handle); }
  public synchronized boolean dismiss(RequestHandle handle) {
    prune();
    Review current = review();
    if (current == null || current.request != handle) return false;
    requests.remove(handle);
    paused = true;
    return true;
  }
  public synchronized boolean resumeReview() {
    prune();
    if (clockFailed || !foreground || !registered(focused) || handoffRetained()) return false;
    paused = false;
    return true;
  }
  public synchronized boolean contains(RequestHandle handle) { prune(); return requests.containsKey(handle); }
  public synchronized List<Expiration> expire() { return Collections.unmodifiableList(prune()); }

  private boolean registered(SessionHandle handle) {
    return handle != null && sessions.get(handle.generation) == handle;
  }
  private boolean mayReview() { return !clockFailed && foreground && !paused && registered(focused); }
  private Review review() {
    if (!mayReview() || approved != null) return null;
    for (Map.Entry<RequestHandle, Request> entry : requests.entrySet()) {
      if (entry.getValue().session == focused) return new Review(entry.getKey(), entry.getValue());
    }
    return null;
  }
  private boolean validApproval(ApprovalHandle handle) {
    if (handle == null || approved != handle || !foreground || clockFailed) return false;
    if (handoff != null && handoff.pending(lastTime)) return false;
    if (paused && !(handoff != null && handoff.resumed(lastTime))) return false;
    Request request = requests.get(handle.request);
    return request != null && request.session == focused && registered(request.session);
  }
  /** Called only by the native signer after its exact review gesture and signing claim. */
  synchronized NativeSigningHold hold(ApprovalHandle grant, long deadline) {
    prune();
    if (!validApproval(grant) || handoff != null || deadline <= lastTime) return null;
    handoff = new NativeSigningHold(Math.min(deadline, requests.get(grant.request).expires));
    return handoff;
  }
  synchronized boolean held(ApprovalHandle grant, NativeSigningHold expected) {
    prune();
    return expected != null && handoff == expected && approved == grant && handoffRetained();
  }
  synchronized boolean resume(ApprovalHandle grant, NativeSigningHold expected) {
    return held(grant, expected) && foreground && expected.resume(lastTime);
  }
  synchronized boolean pending(ApprovalHandle grant) {
    prune();
    return grant != null && approved == grant && handoff != null && handoff.pending(lastTime);
  }
  private boolean handoffRetained() {
    if (handoff == null || !handoff.active(lastTime) || approved == null) return false;
    Request row = requests.get(approved.request);
    return row != null && row.session == focused && registered(row.session);
  }
  private void revokeApproved() {
    handoff = null;
    if (approved != null) requests.remove(approved.request);
    approved = null;
  }
  private List<Expiration> prune() {
    long now;
    try { now = elapsedRealtime.getAsLong(); } catch (RuntimeException failure) { now = -1; }
    if (now < 0 || now < lastTime) clockFailed = true;
    if (!clockFailed) lastTime = now;
    List<Expiration> expired = new ArrayList<>();
    var iterator = requests.entrySet().iterator();
    while (iterator.hasNext()) {
      var entry = iterator.next();
      if (clockFailed || now >= entry.getValue().expires || !registered(entry.getValue().session)) {
        ApprovalHandle grant = approved != null && approved.request == entry.getKey() ? approved : null;
        expired.add(new Expiration(entry.getKey(), grant));
        if (grant != null) approved = null;
        iterator.remove();
      }
    }
    if (handoff != null && !handoffRetained()) revokeApproved();
    return expired;
  }
}
