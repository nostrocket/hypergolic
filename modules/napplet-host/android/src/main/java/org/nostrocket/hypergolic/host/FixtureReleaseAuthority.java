package org.nostrocket.hypergolic.host;

import java.security.MessageDigest;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Trusted Settings owner. This separate registry has no guest message/registration path. */
final class FixtureReleaseAuthority {
  static final class Entry {
    final String token, fixture, identity, server, manifestTags;
    final long epoch;
    final NativeUploadAuthority.SessionHandle session;
    final NativeUploadAuthority.RequestHandle request;
    final NativeUploadAuthority.Review review;
    NativeUploadAuthority.Grant grant;
    boolean verified;
    NativeApprovalAuthority.RequestHandle manifestRequest;
    NativeApprovalAuthority.ApprovalHandle manifestGrant;
    String manifestSnapshot;
    boolean nativeManifestSigned,nativeUploadSigned;
    NativeSigningHold handoff;
    boolean handoffManifest;
    Entry(String token, String fixture, String identity, String server, String tags, long epoch,
      NativeUploadAuthority.SessionHandle session, NativeUploadAuthority.RequestHandle request, NativeUploadAuthority.Review review) {
      this.token=token; this.fixture=fixture; this.identity=identity; this.server=server; manifestTags=tags;
      this.epoch=epoch; this.session=session; this.request=request; this.review=review;
    }
  }
  final NativeUploadAuthority uploads;
  private final NativeApprovalAuthority manifests;
  private NativeApprovalAuthority.SessionHandle manifestSession;
  private String user;
  private long epoch=-1;
  private boolean available, foreground;
  private Entry entry;
  FixtureReleaseAuthority(LongSupplier clock) { uploads=new NativeUploadAuthority(clock); manifests=new NativeApprovalAuthority(clock); }
  synchronized boolean synchronize(String user, long epoch, boolean available) {
    if (user==null || !user.matches("[0-9a-f]{64}") || epoch<0 || epoch>9_007_199_254_740_991L || epoch<this.epoch ||
      (epoch==this.epoch && this.user!=null && !user.equals(this.user))) return false;
    if (!available || epoch!=this.epoch || !user.equals(this.user)) cancel();
    this.user=user; this.epoch=epoch; this.available=available; return true;
  }
  synchronized void foreground(boolean active) {
    foreground=active; uploads.setForeground(active); manifests.setForeground(active);
    if (!active && !held()) cancel();
  }
  synchronized Entry prepare(String fixture, byte[] bytes, String expectedHash, String server, String tags) {
    if(!available || !foreground || fixture==null || !fixture.matches("[a-z][a-z0-9-]{0,63}") || bytes==null ||
      bytes.length<1 || bytes.length>2*1024*1024 || expectedHash==null || !expectedHash.equals(hash(bytes)) ||
      !NativeUploadAuthority.validDestination(server) || tags==null || tags.length()>32*1024) return null;
    cancel(); String token=UUID.randomUUID().toString();
    var session=uploads.register(token,user); if(session==null)return null;
    uploads.focus(session);
    var request=uploads.admit(session,bytes.length,server,"text/html");
    if(request==null){uploads.revoke(session);return null;}
    for(int offset=0;offset<bytes.length;offset+=NativeUploadAuthority.CHUNK_BYTES){
      byte[] chunk=java.util.Arrays.copyOfRange(bytes,offset,Math.min(bytes.length,offset+NativeUploadAuthority.CHUNK_BYTES));
      if(!uploads.append(request,offset,chunk)){uploads.revoke(session);return null;}
    }
    var review=uploads.seal(request); // Raw sealed code bytes are admitted only by this trusted owner.
    if(review==null){uploads.revoke(session);return null;}
    entry=new Entry(token,fixture,user,server,tags,epoch,session,request,review);return entry;
  }
  synchronized Entry current(String token) {
    return available && foreground && entry!=null && (entry.handoff==null || resumed()) && entry.token.equals(token) && entry.identity.equals(user) && entry.epoch==epoch &&
      (entry.verified || uploads.contains(entry.request)) ? entry : null;
  }
  synchronized boolean approveUpload(String token) {
    var row=current(token);if(row==null || row.grant!=null || row.verified)return false;
    row.grant=uploads.approve(row.request,row.review);
    return row.grant!=null && uploads.claimSigning(row.grant)==row.review;
  }
  synchronized boolean uploadApproved(String token) { var row=current(token);return row!=null && row.grant!=null && uploads.isApproved(row.grant); }
  synchronized boolean verifyRetrieved(String token, byte[] retrieved) {
    var row=current(token);if(row==null || !uploadApproved(token) || !uploads.wasDispatched(row.grant) || retrieved==null || retrieved.length!=row.review.size ||
      !hash(retrieved).equals(row.review.sha256))return false;
    row.verified=true;uploads.finish(row.grant);row.handoff=null;return true;
  }
  synchronized boolean prepareManifest(String token,String snapshot) {
    var row=current(token);if(row==null || !row.verified || row.manifestRequest!=null || !available || !foreground)return false;
    row.handoff=null;
    manifestSession=manifests.register(UUID.randomUUID().toString());if(manifestSession==null)return false;
    manifests.setFocused(manifestSession);manifests.resumeReview();row.manifestRequest=manifests.admit(manifestSession,snapshot);
    if(row.manifestRequest!=null)row.manifestSnapshot=snapshot;return row.manifestRequest!=null;
  }
  synchronized String approveManifest(String token) {
    var row=current(token);if(row==null || row.manifestRequest==null || row.manifestGrant!=null)return null;
    row.manifestGrant=manifests.approve(row.manifestRequest);
    return row.manifestGrant==null?null:manifests.take(row.manifestGrant);
  }
  synchronized boolean manifestApproved(String token) {var row=current(token);return row!=null && manifests.isApproved(row.manifestGrant);}
  synchronized boolean claimNativeSigning(String token,Entry expected,boolean manifest) {
    Entry row=current(token);if(row!=expected)return false;
    if(manifest) { if(!manifestApproved(token) || row.nativeManifestSigned)return false;row.nativeManifestSigned=true; }
    else { if(!uploadApproved(token) || row.nativeUploadSigned)return false;row.nativeUploadSigned=true; }
    return true;
  }
  synchronized NativeSigningHold holdSigning(String token, Entry expected, boolean manifest, long deadline) {
    Entry row=current(token);
    if(row!=expected || row.handoff!=null || (manifest ? !row.nativeManifestSigned : !row.nativeUploadSigned)) return null;
    row.handoff=manifest ? manifests.hold(row.manifestGrant,deadline) : uploads.hold(row.grant,deadline);
    row.handoffManifest=manifest;
    return row.handoff;
  }
  private boolean held() {
    return entry!=null && entry.handoff!=null && (entry.handoffManifest ? manifests.held(entry.manifestGrant,entry.handoff) : uploads.held(entry.grant,entry.handoff));
  }
  private boolean resumed() {
    return held() && foreground && (entry.handoffManifest ? manifests.isApproved(entry.manifestGrant) : uploads.isApproved(entry.grant));
  }
  synchronized boolean signingHeld(String token, Entry expected, boolean manifest, NativeSigningHold hold) {
    return entry==expected && entry.token.equals(token) && entry.handoff==hold && entry.handoffManifest==manifest && held();
  }
  synchronized boolean resumeSigning(String token, Entry expected, boolean manifest, NativeSigningHold hold) {
    return signingHeld(token,expected,manifest,hold) && foreground &&
      (manifest ? manifests.resume(entry.manifestGrant,hold) : uploads.resume(entry.grant,hold));
  }
  synchronized void cancel(String token, boolean manifest) {
    if (entry != null && entry.token.equals(token) && entry.verified == manifest) cancel();
  }
  synchronized void cancel(String token) { if (entry != null && entry.token.equals(token)) cancel(); }
  synchronized void cancel() {
    if(entry!=null)uploads.revoke(entry.session);
    if(manifestSession!=null)manifests.teardown(manifestSession);
    entry=null;manifestSession=null;
  }
  static String hash(byte[] bytes) {
    try {StringBuilder result=new StringBuilder(64);for(byte value:MessageDigest.getInstance("SHA-256").digest(bytes)) {
      result.append(Character.forDigit((value >>> 4)&15,16));result.append(Character.forDigit(value&15,16));}return result.toString();}
    catch(java.security.NoSuchAlgorithmException error){throw new IllegalStateException(error);}
  }
}
