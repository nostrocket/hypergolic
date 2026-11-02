package org.nostrocket.hypergolic.signercore;

import android.os.SystemClock;
import java.util.function.LongSupplier;

/** Ephemeral native authority. Same-process ownership, not a separate process or secure hardware. */
public final class NativeSignerCore implements AutoCloseable {
  public static final long LIFETIME_MS = 600_000;
  public static final class Denied extends RuntimeException {
    public Denied() { super("Native signing request denied."); }
  }
  public static final class Review {
    final NativeEvent event;
    final long expires;
    private Review(NativeEvent event, long expires) { this.event = event; this.expires = expires; }
    public String unsignedEvent() { return event.unsigned; }
    public String eventId() { return NativeEvent.hex(event.digest); }
    public String canonicalEvent() { return event.canonical; }
  }
  private final Object owner;
  private final LongSupplier elapsed;
  private NativeSigningKey key;
  private Review pending, consumed;
  private String reviewPubkey;
  private boolean foreground = true, closed;
  private long lastTime = -1, keyExpires;

  public NativeSignerCore(Object owner) { this(owner, SystemClock::elapsedRealtime); }
  /** Native test clock injection only; no bridge method accepts clock or owner. */
  NativeSignerCore(Object owner, LongSupplier elapsed) {
    if (owner == null || elapsed == null) throw new Denied();
    this.owner = owner; this.elapsed = elapsed;
  }
  static NativeSignerCore ownedKey(Object owner,NativeSigningKey key) {
    NativeSignerCore result=new NativeSignerCore(owner);long time=result.now();
    if(key==null || time>Long.MAX_VALUE-LIFETIME_MS) { if(key!=null)key.close();throw new Denied(); }
    result.key=key;result.keyExpires=time+LIFETIME_MS;return result;
  }
  static NativeSignerCore reviewOnly(Object owner, String pubkey) {
    if (!NativeSigningKey.validPublicKey(pubkey)) throw new Denied();
    NativeSignerCore result = new NativeSignerCore(owner);
    result.reviewPubkey = pubkey;
    result.keyExpires = result.now() + LIFETIME_MS;
    return result;
  }
  private long now() {
    long value;
    try { value = elapsed.getAsLong(); } catch (RuntimeException error) { close(); throw new Denied(); }
    if (value < 0 || value < lastTime) { close(); throw new Denied(); }
    lastTime = value; return value;
  }
  private void requireOwner(Object context) {
    if (context != owner || closed || !foreground) throw new Denied();
  }
  private void requireKey(Object context) {
    requireOwner(context);
    if (key == null && reviewPubkey == null || now() >= keyExpires) { close(); throw new Denied(); }
  }
  public synchronized String generateDisposableIdentity(Object context) {
    requireOwner(context);
    if (pending != null) throw new Denied();
    if (key != null) { requireKey(context); return key.publicKey(); }
    long time = now();
    if (time > Long.MAX_VALUE - LIFETIME_MS) { close(); throw new Denied(); }
    key = new NativeSigningKey(); keyExpires = time + LIFETIME_MS;
    return key.publicKey();
  }
  public synchronized Review admit(Object context, String unsignedEvent) {
    requireKey(context);
    if (pending != null && now() >= pending.expires) pending = null;
    if (pending != null) throw new Denied();
    NativeEvent event = NativeEvent.capture(unsignedEvent, key == null ? reviewPubkey : key.publicKey());
    pending = new Review(event, Math.min(keyExpires, now() + LIFETIME_MS)); return pending;
  }
  synchronized boolean canReview(Object context, Review review) {
    try { requireKey(context); return review != null && pending == review && now() < review.expires; }
    catch (Denied error) { return false; }
  }
  /** Sole production caller is the native review button. Consume before any cryptographic effect. */
  synchronized String approveOnce(Object context, Review review) {
    if (key == null || !canReview(context, review)) throw new Denied();
    pending = null;
    String result = review.event.signed(key.sign(review.event.digest));
    requireKey(context); return result;
  }
  synchronized NativeEvent consumeOnce(Object context, Review review) {
    if (!canReview(context, review) || consumed != null) throw new Denied();
    pending = null;
    consumed = review;
    return review.event;
  }
  synchronized boolean canFinish(Object context, Review review) {
    try { requireKey(context); return review != null && consumed == review && now() < review.expires; }
    catch (Denied failure) { return false; }
  }
  public synchronized void reject(Object context, Review review) {
    requireOwner(context);
    if (pending == review) pending = null;
    if (consumed == review) consumed = null;
  }
  public synchronized void cancel(Object context) { requireOwner(context); pending = null; consumed = null; }
  public synchronized void background() { foreground = false; close(); }
  @Override public synchronized void close() {
    pending = null; consumed = null; closed = true;
    if (key != null) { key.close(); key = null; }
  }
}
