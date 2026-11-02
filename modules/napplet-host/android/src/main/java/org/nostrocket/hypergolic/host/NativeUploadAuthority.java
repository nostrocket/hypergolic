package org.nostrocket.hypergolic.host;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** Native-only reviewed upload bodies. Host origin/sequence admission must precede this core.
 * No signer, bridge or network effect is exposed by this class. */
public final class NativeUploadAuthority {
  public static final int MAX_BYTES = 10 * 1024 * 1024;
  public static final int CHUNK_BYTES = 256 * 1024;
  public static final long REVIEW_MS = 600_000;
  public static final long TRANSFER_MS = 60_000;
  public static final class SessionHandle {
    private final String generation, identity;
    private SessionHandle(String generation, String identity) { this.generation = generation; this.identity = identity; }
  }
  public static final class RequestHandle { private RequestHandle() {} }
  public static final class Grant {
    private final RequestHandle request;
    private final NativeUploadAuthority owner;
    private boolean dispatched;
    private Grant(RequestHandle request, NativeUploadAuthority owner) { this.request = request; this.owner = owner; }
  }
  public static final class Review {
    public final String purpose = "blossom-upload";
    public final String identity, destination, mimeType, sha256, metadataPolicy;
    public final int size;
    private final boolean validatedWav;
    public boolean acceptsDescriptorType(String type) {
      return mimeType.equals(type) || validatedWav && "audio/x-wav".equals(type);
    }
    private Review(Row row, String hash) {
      identity = row.session.identity; destination = row.destination; mimeType = row.mimeType; metadataPolicy = row.metadataPolicy;
      validatedWav = "audio/wav".equals(mimeType) && "audio/wav".equals(UploadFileProfile.attachmentType(row.body));
      sha256 = hash; size = row.body.length;
    }
  }
  private static final class Row {
    final SessionHandle session;
    final String destination;
    String mimeType;
    String metadataPolicy = "attachment-unchanged";
    byte[] body;
    int cursor;
    long expires;
    Review review;
    Grant grant;
    NativeSigningHold handoff;
    boolean signingClaimed, transferClaimed, dispatched;
    Row(SessionHandle session, String destination, String mimeType, int length, long expires) {
      this.session = session; this.destination = destination; this.mimeType = mimeType;
      body = new byte[length]; this.expires = expires;
    }
    void clear() { Arrays.fill(body, (byte) 0); }
  }
  private final LongSupplier clock;
  private final java.util.function.Function<byte[], UploadFileProfile.Prepared> prepare;
  private final Map<String, SessionHandle> sessions = new HashMap<>();
  private final Map<RequestHandle, Row> requests = new HashMap<>();
  private SessionHandle focused;
  private boolean foreground, clockFailed;
  private long lastTime = -1;

  public NativeUploadAuthority(LongSupplier clock) { this(clock, UploadFileProfile::prepare); }
  NativeUploadAuthority(LongSupplier clock, java.util.function.Function<byte[], UploadFileProfile.Prepared> prepare) { this.clock = clock; this.prepare = prepare; }
  public synchronized SessionHandle register(String generation, String identity) {
    prune();
    if (clockFailed || generation == null || !generation.matches("[A-Za-z0-9_-]{1,80}") ||
      identity == null || !identity.matches("[0-9a-f]{64}") || sessions.containsKey(generation) || sessions.size() >= 64) return null;
    SessionHandle session = new SessionHandle(generation, identity); sessions.put(generation, session); return session;
  }
  public synchronized void setForeground(boolean active) {
    prune(); foreground = active;
    if (active) { for (Row row : requests.values()) if (row.handoff != null) row.handoff.foreground(); }
    else requests.entrySet().removeIf(entry -> {
      Row row = entry.getValue();
      if (row.handoff != null) row.handoff.background();
      if (retained(row)) return false;
      row.clear(); return true;
    });
  }
  public synchronized void focus(SessionHandle session) {
    prune(); if (session != null && !registered(session)) return;
    if (focused != session) cancelHeld();
    focused = session;
  }
  public synchronized boolean clearFocus(SessionHandle session) {
    prune(); if (focused != session || session == null) return false; cancelHeld(); focused = null; return true;
  }
  public synchronized void revoke(SessionHandle session) {
    prune(); if (!registered(session)) return;
    sessions.remove(session.generation); if (focused == session) focused = null;
    requests.entrySet().removeIf(entry -> { if (entry.getValue().session != session) return false; entry.getValue().clear(); return true; });
  }
  public synchronized void revokeAll() {
    for (Row row : requests.values()) row.clear(); requests.clear(); sessions.clear(); focused = null;
  }
  /** Destination is an independently checked canonical public HTTPS origin; final DNS/TLS checks belong to the PUT owner. */
  public synchronized RequestHandle admit(SessionHandle session, int length, String destination, String mimeType) {
    prune();
    if (clockFailed || !foreground || !registered(session) || length < 0 || length > MAX_BYTES ||
      !validDestination(destination) || mimeType == null || !mimeType.matches("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*") || mimeType.length() > 128 ||
      requests.size() >= 10 || requests.values().stream().filter(row -> row.grant == null).count() >= 8 || requests.values().stream().anyMatch(row -> row.session == session) || lastTime > Long.MAX_VALUE - REVIEW_MS) return null;
    RequestHandle request = new RequestHandle(); requests.put(request, new Row(session, destination, mimeType, length, lastTime + REVIEW_MS)); return request;
  }
  /** Exact offset, private native handle, and bounded copied chunk. No replay or post-seal writes. */
  public synchronized boolean append(RequestHandle request, int offset, byte[] chunk) {
    prune(); Row row = live(request);
    if (row == null || row.review != null || chunk == null || chunk.length < 1 || chunk.length > CHUNK_BYTES ||
      offset != row.cursor || chunk.length > row.body.length - row.cursor) return false;
    System.arraycopy(chunk, 0, row.body, row.cursor, chunk.length); row.cursor += chunk.length; return true;
  }
  public synchronized Review seal(RequestHandle request) {
    prune(); Row row = live(request);
    if (row == null || row.review != null || row.cursor != row.body.length) return null;
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(row.body);
      StringBuilder hash = new StringBuilder(64); for (byte value : digest) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
      row.review = new Review(row, hash.toString()); return row.review;
    } catch (NoSuchAlgorithmException failure) { row.clear(); requests.remove(request); return null; }
  }
  /** Owning byte preparation before hashing/review; guest MIME never classifies the file. */
  public synchronized Review sealPreparedFile(RequestHandle request) {
    prune(); Row row = live(request);
    if (row == null || row.review != null || row.cursor != row.body.length) return null;
    UploadFileProfile.Prepared result = prepare.apply(row.body);
    byte[] prepared = result == null ? null : result.bytes();
    if (prepared == null) { cancel(request); return null; }
    row.clear(); row.body = prepared; row.cursor = prepared.length; row.mimeType = result.mimeType(); row.metadataPolicy = result.metadataPolicy();
    return seal(request);
  }
  public synchronized boolean contains(RequestHandle request) { prune(); return live(request) != null; }
  public synchronized boolean mayReview(RequestHandle request, Review expected) {
    prune(); Row row = live(request); return row != null && row.session == focused && row.review != null && row.review == expected && row.grant == null;
  }
  public synchronized byte[] preview(RequestHandle request, Review expected) {
    return mayReview(request, expected) ? requests.get(request).body.clone() : null;
  }
  public synchronized byte[] previewChunk(RequestHandle request, Review expected, int offset) {
    if (!mayReview(request, expected) || offset < 0 || offset >= expected.size || offset % CHUNK_BYTES != 0) return null;
    Row row = requests.get(request); return Arrays.copyOfRange(row.body, offset, Math.min(row.body.length, offset + CHUNK_BYTES));
  }
  public synchronized Grant approve(RequestHandle request, Review expected) {
    if (!mayReview(request, expected) || requests.values().stream().filter(row -> row.grant != null).count() >= 2 || lastTime > Long.MAX_VALUE - TRANSFER_MS) return null;
    Row row = requests.get(request); row.grant = new Grant(request, this); row.expires = lastTime + TRANSFER_MS; return row.grant;
  }
  public synchronized Review approvedReview(Grant grant) { prune(); Row row = approved(grant); return row == null ? null : row.review; }
  public synchronized boolean isApproved(Grant grant) { prune(); return approved(grant) != null; }
  /** One signing claim for this purpose. The protected signer must also verify Review's exact server/hash/identity template. */
  public synchronized Review claimSigning(Grant grant) {
    prune(); Row row = approved(grant); if (row == null || row.signingClaimed) return null; row.signingClaimed = true; return row.review;
  }
  public synchronized boolean claimTransfer(Grant grant) {
    prune(); Row row = approved(grant); if (row == null || !row.signingClaimed || row.transferClaimed) return false;
    row.transferClaimed = true; return true;
  }
  public synchronized void cancelGrant(Grant grant) { if (grant != null && grant.owner == this) cancel(grant.request); }
  /** One network dispatch; the native PUT owner retains the grant and rechecks isApproved during I/O. */
  public synchronized byte[] dispatch(Grant grant) {
    prune(); Row row = approved(grant); if (row == null || !row.signingClaimed || !row.transferClaimed || row.dispatched) return null;
    row.dispatched = true; grant.dispatched = true; return row.body.clone();
  }
  public synchronized boolean wasDispatched(Grant grant) { return grant != null && grant.owner == this && grant.dispatched; }
  /** Cancellation revokes local authority only. A dispatched remote outcome may remain unknown. */
  public synchronized void cancel(RequestHandle request) { Row row = requests.remove(request); if (row != null) row.clear(); }
  public synchronized void finish(Grant grant) { prune(); if (grant != null && approved(grant) != null) cancel(grant.request); }
  private boolean registered(SessionHandle session) { return session != null && sessions.get(session.generation) == session; }
  private Row live(RequestHandle request) {
    Row row = requests.get(request);
    return foreground && row != null && registered(row.session) && (row.handoff == null || row.handoff.resumed(lastTime)) ? row : null;
  }
  private boolean retained(Row row) {
    return row.handoff != null && row.handoff.active(lastTime) && registered(row.session) && row.session == focused && (row.handoff.resumed(lastTime) || !row.dispatched);
  }
  private void cancelHeld() {
    requests.entrySet().removeIf(entry -> {
      if (entry.getValue().handoff == null) return false;
      entry.getValue().clear(); return true;
    });
  }
  synchronized NativeSigningHold hold(Grant grant, long deadline) {
    prune(); Row row = approved(grant);
    if (row == null || !row.signingClaimed || row.transferClaimed || row.dispatched || deadline <= lastTime ||
        requests.values().stream().anyMatch(value -> value.handoff != null)) return null;
    row.handoff = new NativeSigningHold(Math.min(deadline, row.expires));
    return row.handoff;
  }
  synchronized boolean held(Grant grant, NativeSigningHold expected) {
    prune(); Row row = grant == null ? null : requests.get(grant.request);
    return row != null && row.grant == grant && row.handoff == expected && retained(row);
  }
  synchronized boolean retained(RequestHandle request) { prune(); Row row = requests.get(request); return row != null && retained(row); }
  synchronized boolean resume(Grant grant, NativeSigningHold expected) {
    return held(grant, expected) && foreground && expected.resume(lastTime);
  }
  private Row approved(Grant grant) { Row row = grant == null ? null : live(grant.request); return row != null && row.grant == grant ? row : null; }
  private void prune() {
    long sampled; try { sampled = clock.getAsLong(); } catch (RuntimeException failure) { sampled = -1; }
    final long now = sampled;
    if (now < 0 || now < lastTime) clockFailed = true; if (!clockFailed) lastTime = now;
    requests.entrySet().removeIf(entry -> { Row row = entry.getValue(); if (!clockFailed && now < row.expires && registered(row.session) && (row.handoff == null || retained(row))) return false; row.clear(); return true; });
  }
  static boolean validDestination(String value) {
    try {
      if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 2048 || !value.matches("[!-~]+") || value.indexOf('\\') >= 0) return false;
      URI url = new URI(value); String host = url.getHost();
      if (!"https".equals(url.getScheme()) || host == null || host.length() > 253 || !host.equals(host.toLowerCase(java.util.Locale.ROOT)) ||
        url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null || !url.getRawPath().isEmpty() ||
        url.getPort() == 0 || url.getPort() > 65535 || url.getPort() == 443 || !host.contains(".") || host.matches("[0-9.]+")) return false;
      for (String suffix : new String[]{"localhost","local","internal","home","home.arpa","lan","test","example","invalid","onion","arpa"}) if (host.equals(suffix) || host.endsWith("." + suffix)) return false;
      for (String label : host.split("\\.", -1)) if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) return false;
      return value.equals("https://" + host + (url.getPort() == -1 ? "" : ":" + url.getPort()));
    } catch (Exception invalid) { return false; }
  }
}
