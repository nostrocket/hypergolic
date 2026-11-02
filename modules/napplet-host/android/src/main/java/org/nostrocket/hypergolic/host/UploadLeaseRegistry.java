package org.nostrocket.hypergolic.host;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Private lookup tokens for native upload requests and their captured registrations. */
final class UploadLeaseRegistry {
  static final class Taken {
    final String registration, request, uploadId;
    final NativeUploadAuthority.Review review;
    final Object marker;
    Taken(Row row) { marker=row; registration = row.session.registration; request = row.requestText; uploadId = row.uploadId; review = row.review; }
  }
  static final class Transfer {
    final NativeUploadAuthority authority;
    final NativeUploadAuthority.Grant grant;
    final NativeBlossomPermit permit;
    final String registration, uploadId;
    Transfer(NativeUploadAuthority authority, NativeUploadAuthority.Grant grant, NativeBlossomPermit permit, String registration, String uploadId) {
      this.registration = registration; this.uploadId = uploadId;
      this.authority = authority; this.grant = grant; this.permit = permit;
    }
  }
  static final class Invalid {
    final String token, generation, uploadId;
    final boolean dispatched;
    Invalid(String token, Row row, boolean dispatched) { this.token = token; generation = row.session.generation; uploadId = row.uploadId; this.dispatched = dispatched; }
  }
  private static final class Session {
    final String generation, registration;
    final NativeUploadAuthority.SessionHandle handle;
    final HashSet<String> callerIds = new HashSet<>();
    Session(String generation, String registration, NativeUploadAuthority.SessionHandle handle) {
      this.generation = generation; this.registration = registration; this.handle = handle;
    }
  }
  private static final class Row {
    final Session session;
    final String requestText, uploadId;
    final NativeUploadAuthority.RequestHandle request;
    int cursor;
    boolean claimed;
    boolean nativeSigned;
    NativeSigningHold handoff;
    NativeUploadAuthority.Review review;
    NativeUploadAuthority.Grant grant;
    Row(Session session, String requestText, NativeUploadAuthority.RequestHandle request) {
      this.session = session; this.requestText = requestText; this.request = request; uploadId = UUID.randomUUID().toString();
    }
  }
  private final NativeUploadAuthority authority;
  private final Map<String, Session> sessions = new HashMap<>();
  private final Map<String, Row> rows = new HashMap<>();
  private final LinkedHashMap<String, Boolean> dispatchedHistory = new LinkedHashMap<>();
  UploadLeaseRegistry(LongSupplier clock) { this(clock, UploadFileProfile::prepare); }
  UploadLeaseRegistry(LongSupplier clock, java.util.function.Function<byte[], UploadFileProfile.Prepared> prepare) { authority = new NativeUploadAuthority(clock, prepare); }
  synchronized boolean register(String generation, String identity, String registration, boolean granted) {
    if (!granted || registration == null || registration.length() > 8192 || sessions.containsKey(generation)) return false;
    var handle = authority.register(generation, identity); if (handle == null) return false;
    sessions.put(generation, new Session(generation, registration, handle)); return true;
  }
  synchronized boolean isRegistered(String generation) { return sessions.containsKey(generation); }
  synchronized void foreground(boolean active) { authority.setForeground(active); }
  synchronized void focus(String generation, boolean active) {
    Session session = sessions.get(generation); if (session == null) return;
    if (active) authority.focus(session.handle); else authority.clearFocus(session.handle);
  }
  synchronized String begin(String generation, String callerId, String requestText, int length, String destination) {
    Session session = sessions.get(generation);
    if (session == null || callerId == null || callerId.isEmpty() || callerId.length() > 128 || requestText == null ||
      requestText.length() > 32 * 1024 || rows.size() >= 10 || session.callerIds.size() >= 1024 ||
      session.callerIds.contains(callerId) || rows.values().stream().anyMatch(row -> row.session == session)) return null;
    var request = authority.admit(session.handle, length, destination, "application/octet-stream"); if (request == null) return null;
    String token = UUID.randomUUID().toString();
    Row row = new Row(session, requestText, request);
    if (token.equals(row.uploadId) || rows.containsKey(token)) { authority.cancel(request); return null; }
    session.callerIds.add(callerId); rows.put(token, row); return token;
  }
  synchronized String publicId(String generation, String token) { Row row = owned(generation, token); return row == null ? null : row.uploadId; }
  synchronized String publicIdForApp(String token) { Row row = rows.get(token); return row != null && row.claimed ? row.uploadId : null; }
  synchronized int append(String generation, String token, int offset, byte[] chunk) {
    Row row = owned(generation, token);
    if (row == null || row.claimed || row.review != null || !authority.append(row.request, offset, chunk)) return -1;
    row.cursor += chunk.length; return row.cursor;
  }
  synchronized boolean seal(String generation, String token) {
    Row row = owned(generation, token); if (row == null || row.claimed || row.review != null) return false;
    row.review = authority.sealPreparedFile(row.request); return row.review != null;
  }
  synchronized NativeUploadAuthority.Review sealedReview(String generation, String token) { Row row = owned(generation, token); return row == null ? null : row.review; }
  synchronized Taken take(String token) {
    Row row = rows.get(token);
    if (row == null || row.claimed || row.review == null || !authority.contains(row.request)) return null;
    row.claimed = true; return new Taken(row);
  }
  synchronized Taken signingCapture(String token) {
    Row row=rows.get(token);return row!=null && isApproved(token) && !row.nativeSigned?new Taken(row):null;
  }
  synchronized boolean signingCurrent(String token,Object marker) { return rows.get(token)==marker && isApproved(token); }
  synchronized boolean claimNativeSigning(String token,Object marker) {
    Row row=rows.get(token);if(row!=marker || !isApproved(token) || row.nativeSigned)return false;row.nativeSigned=true;return true;
  }
  synchronized NativeSigningHold holdSigning(String token, Object marker, long deadline) {
    Row row = rows.get(token);
    if (row != marker || !row.nativeSigned || row.handoff != null) return null;
    row.handoff = authority.hold(row.grant, deadline);
    return row.handoff;
  }
  synchronized boolean signingHeld(String token, Object marker, NativeSigningHold expected) {
    Row row = rows.get(token);
    return row == marker && row.nativeSigned && row.handoff == expected && authority.held(row.grant, expected);
  }
  synchronized boolean resumeSigning(String token, Object marker, NativeSigningHold expected) {
    Row row = rows.get(token);
    return signingHeld(token, marker, expected) && authority.resume(row.grant, expected);
  }
  synchronized boolean isLive(String token) { Row row = rows.get(token); return row != null && row.claimed && authority.contains(row.request); }
  synchronized boolean mayReview(String token) {
    Row row = rows.get(token); return row != null && row.claimed && row.review != null && authority.mayReview(row.request, row.review);
  }
  synchronized byte[] preview(String token, int offset) {
    Row row = rows.get(token); if (row == null || !mayReview(token) || offset < 0 || offset >= row.review.size || offset % NativeUploadAuthority.CHUNK_BYTES != 0) return null;
    return authority.previewChunk(row.request, row.review, offset);
  }
  synchronized boolean approve(String token) {
    Row row = rows.get(token); if (row == null || !mayReview(token) || row.grant != null) return false;
    row.grant = authority.approve(row.request, row.review); return row.grant != null;
  }
  synchronized boolean isApproved(String token) { Row row = rows.get(token); return row != null && row.claimed && authority.isApproved(row.grant); }
  synchronized boolean claimSigning(String token) {
    Row row = rows.get(token); return row != null && row.claimed && authority.claimSigning(row.grant) == row.review && row.review != null;
  }
  synchronized Transfer transfer(String token, String credential, long now) {
    Row row = rows.get(token); if (row == null || !isApproved(token)) return null;
    var permit = NativeBlossomPermit.capture(row.review, credential, now);
    return permit == null ? null : new Transfer(authority, row.grant, permit, row.session.registration, row.uploadId);
  }
  synchronized boolean wasDispatched(String token) {
    Row row = rows.get(token);
    if (row != null) return authority.wasDispatched(row.grant);
    return dispatchedHistory.getOrDefault(token, true); // Missing evidence cannot prove no dispatch.
  }
  synchronized boolean cancelOwned(String generation, String token) {
    Row row = owned(generation, token); if (row == null) return false; cancel(token); return true;
  }
  synchronized void cancel(String token) { Row row = rows.get(token); if (row != null) authority.cancel(row.request); }
  synchronized boolean finish(String token) {
    Row row = rows.get(token); if (row == null) return false;
    boolean approved = row.claimed && authority.isApproved(row.grant); remove(token, row); return approved;
  }
  synchronized void revoke(String generation) { Session session = sessions.remove(generation); if (session != null) authority.revoke(session.handle); }
  synchronized void revokeAll() { authority.revokeAll(); sessions.clear(); }
  synchronized List<Invalid> drainInvalid() {
    var invalid = new ArrayList<Invalid>();
    for (String token : new ArrayList<>(rows.keySet())) {
      Row row = rows.get(token);
      if (sessions.get(row.session.generation) == row.session && (authority.contains(row.request) || authority.retained(row.request))) continue;
      boolean dispatched = authority.wasDispatched(row.grant); invalid.add(new Invalid(token, row, dispatched)); remove(token, row);
    }
    return invalid;
  }
  private Row owned(String generation, String token) {
    Row row = rows.get(token); return row != null && row.session == sessions.get(generation) && row.session.generation.equals(generation) ? row : null;
  }
  private void remove(String token, Row row) {
    dispatchedHistory.put(token, authority.wasDispatched(row.grant));
    while (dispatchedHistory.size() > 128) dispatchedHistory.remove(dispatchedHistory.keySet().iterator().next());
    rows.remove(token); authority.cancel(row.request);
  }
}
