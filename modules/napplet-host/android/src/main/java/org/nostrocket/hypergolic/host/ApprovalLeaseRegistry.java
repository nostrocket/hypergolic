package org.nostrocket.hypergolic.host;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Process-owned transport tokens wrap opaque approval handles; no handle is accepted from JavaScript. */
public final class ApprovalLeaseRegistry {
  private final NativeApprovalAuthority authority;
  private boolean wasForeground;
  private final Map<String, NativeApprovalAuthority.SessionHandle> sessions = new HashMap<>();
  private final Map<String, Row> rows = new HashMap<>();
  private static final class Row {
    final String generation;
    final String snapshot;
    final NativeApprovalAuthority.RequestHandle request;
    boolean claimed;
    boolean requiresPlan;
    Object preparedPlan;
    Object signingMetadata;
    boolean nativeSigned;
    NativeSigningHold handoff;
    NativeApprovalAuthority.ApprovalHandle approval;
    Row(String generation, String snapshot, NativeApprovalAuthority.RequestHandle request) {
      this.generation = generation; this.snapshot = snapshot; this.request = request;
    }
  }
  public ApprovalLeaseRegistry(LongSupplier clock) { authority = new NativeApprovalAuthority(clock); }
  public synchronized boolean register(String generation) {
    if (sessions.containsKey(generation)) return false;
    var handle = authority.register(generation);
    if (handle == null) return false;
    sessions.put(generation, handle); return true;
  }
  public synchronized void foreground(boolean active) {
    if (active || wasForeground) authority.setForeground(active);
    if (active) wasForeground = true;
  }
  public synchronized void focus(String generation, boolean active) {
    var session = sessions.get(generation);
    if (session == null) return;
    if (active) authority.setFocused(session); else authority.clearFocused(session);
  }
  public synchronized void resume() { authority.resumeReview(); }
  public synchronized String admit(String generation, String snapshot) {
    return admit(generation, snapshot, false);
  }
  public synchronized String admit(String generation, String snapshot, boolean requiresPlan) {
    var session = sessions.get(generation);
    if (session == null) return null;
    var request = authority.admit(session, snapshot);
    if (request == null) return null;
    String token = UUID.randomUUID().toString();
    Row row = new Row(generation, snapshot, request);
    row.requiresPlan = requiresPlan; rows.put(token, row);
    return token;
  }
  public synchronized String take(String token) {
    Row row = rows.get(token);
    if (row == null || row.claimed || !authority.contains(row.request)) return null;
    row.claimed = true; return row.snapshot;
  }
  public synchronized boolean isLive(String token) {
    Row row = rows.get(token);
    return row != null && row.claimed && sessions.containsKey(row.generation) && authority.contains(row.request) && !authority.pending(row.approval);
  }
  public synchronized boolean mayReview(String token) {
    Row row = rows.get(token);
    if (row == null || !row.claimed || (row.requiresPlan && row.preparedPlan == null)) return false;
    var current = authority.currentReview();
    return current != null && current.request == row.request;
  }
  public synchronized boolean approve(String token) {
    Row row = rows.get(token);
    if (row == null || !row.claimed || row.approval != null || (row.requiresPlan && row.preparedPlan == null)) return false;
    var approval = authority.approve(row.request);
    if (approval == null) return false;
    if (!row.snapshot.equals(authority.take(approval))) { authority.cancel(approval); return false; }
    row.approval = approval; return true;
  }
  public synchronized String claimedSnapshot(String token) {
    return isLive(token) ? rows.get(token).snapshot : null;
  }
  public synchronized boolean prepare(String token, Object plan) {
    Row row = rows.get(token);
    if (plan == null || !isLive(token) || !row.requiresPlan || row.preparedPlan != null || row.approval != null) return false;
    row.preparedPlan = plan; return true;
  }
  public synchronized boolean prepareSigning(String token,Object metadata) {
    Row row=rows.get(token);
    if(row==null || metadata==null || !isLive(token) || row.approval!=null || row.signingMetadata!=null)return false;
    row.signingMetadata=metadata;return true;
  }
  public synchronized Object signingPrepared(String token) { Row row=rows.get(token);return row==null || !isLive(token)?null:row.signingMetadata; }
  public synchronized boolean signingFresh(String token,Object metadata) {
    Row row=rows.get(token);return row!=null && isApproved(token) && row.signingMetadata==metadata && !row.nativeSigned;
  }
  public synchronized boolean claimNativeSigning(String token,Object metadata) {
    if(!signingFresh(token,metadata))return false;rows.get(token).nativeSigned=true;return true;
  }
  synchronized NativeSigningHold holdSigning(String token, Object metadata, long deadline) {
    Row row = rows.get(token);
    if (row == null || !row.nativeSigned || row.signingMetadata != metadata || row.handoff != null) return null;
    row.handoff = authority.hold(row.approval, deadline);
    return row.handoff;
  }
  synchronized boolean signingHeld(String token, Object metadata, NativeSigningHold expected) {
    Row row = rows.get(token);
    return row != null && row.nativeSigned && row.signingMetadata == metadata && row.handoff == expected && authority.held(row.approval, expected);
  }
  synchronized boolean resumeSigning(String token, Object metadata, NativeSigningHold expected) {
    Row row = rows.get(token);
    return signingHeld(token, metadata, expected) && authority.resume(row.approval, expected);
  }
  public synchronized Object prepared(String token) {
    Row row = rows.get(token); return row == null ? null : row.preparedPlan;
  }
  @FunctionalInterface public interface ApprovedEffect { void run() throws java.io.IOException; }
  /** Revocation and exact EVENT emission share this lock; no queued JS liveness race. */
  public synchronized void performApproved(String token, ApprovedEffect effect) throws java.io.IOException {
    if (!isApproved(token)) throw new java.io.IOException("Approval revoked");
    effect.run();
  }
  public synchronized boolean isApproved(String token) {
    Row row = rows.get(token);
    return row != null && row.claimed && row.approval != null && authority.isApproved(row.approval);
  }
  /** Called on the reply-owning UI thread, after the last liveness check and before reply delivery. */
  public synchronized boolean finish(String token) {
    boolean approved = isApproved(token);
    cancel(token);
    return approved;
  }
  public synchronized void dismiss(String token) {
    Row row = rows.get(token);
    if (row != null && row.claimed && authority.dismiss(row.request)) rows.remove(token);
  }
  public synchronized void cancel(String token) {
    Row row = rows.remove(token);
    if (row != null) authority.cancel(row.request);
  }
  public synchronized void revoke(String generation) {
    var session = sessions.remove(generation);
    if (session != null) authority.teardown(session);
    // Retain dead rows until drainInvalid so their original replies receive terminal cleanup.
  }
  public synchronized List<String> drainInvalid() {
    authority.expire();
    var result = new ArrayList<String>();
    var iterator = rows.entrySet().iterator();
    while (iterator.hasNext()) {
      var entry = iterator.next();
      if (!sessions.containsKey(entry.getValue().generation) || !authority.contains(entry.getValue().request)) {
        result.add(entry.getKey()); iterator.remove();
      }
    }
    return result;
  }
}
