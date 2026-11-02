package org.nostrocket.hypergolic.host;

import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;

/** Actual Java owner logic with a controlled native clock; no system UI/network claim. */
public final class UploadAuthorityProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private static final String ID = "a".repeat(64), SERVER = "https://files.example.com";
  private static byte[] body() { return new byte[]{1,2,3}; }
  private static NativeUploadAuthority.RequestHandle ready(NativeUploadAuthority owner, NativeUploadAuthority.SessionHandle session) {
    NativeUploadAuthority.RequestHandle request = owner.admit(session, 3, SERVER, "image/png"); check(request != null);
    check(owner.append(request, 0, body())); check(owner.seal(request) != null); return request;
  }
  public static void main(String[] args) {
    AtomicLong time = new AtomicLong(100);
    NativeUploadAuthority owner = new NativeUploadAuthority(time::get);
    var a = owner.register("a", ID); var b = owner.register("b", "b".repeat(64)); var c = owner.register("c", ID);
    check(a != null && b != null && c != null); check(owner.register("a", ID) == null);
    check(owner.register("bad", "not-a-key") == null);
    check(owner.admit(a, 3, SERVER, "image/png") == null);
    owner.setForeground(true); owner.focus(a);
    for (String server : new String[]{"http://files.example.com", "https://localhost", "https://127.0.0.1", "https://2130706433",
      "https://files.example.com/upload", "https://files.example.com/", "https://files.example.com:443", "https://FILES.example.com",
      "https://files.example.com?x=y", "https://user@files.example.com", "https://files.example.com#secret", "https://files.example.com:0",
      "https://files.example.com:65536", "https://files.example.com:\n"}) check(owner.admit(a, 3, server, "image/png") == null);
    check(owner.admit(a, NativeUploadAuthority.MAX_BYTES+1, SERVER, "image/png") == null);
    check(owner.admit(a, 3, SERVER, "image/png; charset=x") == null);
    var request = owner.admit(a, 3, SERVER, "image/png"); check(request != null); check(owner.seal(request) == null);
    check(owner.admit(a, 1, SERVER, "image/png") == null);
    check(!owner.append(request, 1, body())); check(!owner.append(request, 0, new byte[4]));
    byte[] input = body(); check(owner.append(request, 0, input)); Arrays.fill(input, (byte) 9);
    check(!owner.append(request, 0, body())); var review = owner.seal(request); check(review != null);
    check(review.sha256.equals("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"));
    check(review.identity.equals(ID) && review.size == 3 && review.destination.equals(SERVER) && review.purpose.equals("blossom-upload"));
    check(owner.seal(request) == null); check(!owner.append(request, 0, body()));
    byte[] preview = owner.preview(request, review); check(Arrays.equals(preview, body())); preview[0] = 99;
    check(Arrays.equals(owner.preview(request, review), body()));
    var other = owner.admit(b, 1, SERVER, "text/plain"); check(other != null);
    var third = owner.admit(c, 1, SERVER, "text/plain"); check(third != null); owner.cancel(third); check(owner.append(other, 0, new byte[]{4}));
    var otherReview = owner.seal(other); check(otherReview != null); check(!owner.mayReview(other, otherReview));
    check(owner.approve(request, otherReview) == null);
    owner.focus(b); check(owner.approve(request, review) == null); check(owner.preview(request, review) == null);
    owner.focus(a); check(!owner.clearFocus(b)); check(owner.mayReview(request, review));
    var grant = owner.approve(request, review); check(grant != null); check(owner.approve(request, review) == null);
    check(owner.dispatch(grant) == null); check(!owner.wasDispatched(grant));
    check(owner.claimSigning(grant) == review); check(owner.claimSigning(grant) == null);
    check(owner.dispatch(grant) == null); check(owner.claimTransfer(grant)); check(!owner.claimTransfer(grant));
    owner.focus(b); check(owner.isApproved(grant)); check(owner.clearFocus(b)); check(owner.isApproved(grant));
    byte[] sent = owner.dispatch(grant); check(Arrays.equals(sent, body())); sent[0] = 88;
    check(owner.wasDispatched(grant)); check(owner.dispatch(grant) == null);
    owner.cancel(request); check(!owner.isApproved(grant)); check(owner.dispatch(grant) == null); check(owner.wasDispatched(grant));
    owner.cancel(other);
    var staged = owner.admit(a, 3, SERVER, "image/png"); check(staged != null);
    owner.setForeground(false); owner.setForeground(true); check(!owner.append(staged, 0, body()));
    owner.focus(a); var background = owner.admit(a, 3, SERVER, "image/png"); check(background != null);
    check(owner.append(background, 0, body())); var backgroundReview = owner.seal(background);
    var backgroundGrant = owner.approve(background, backgroundReview); check(backgroundGrant != null);
    owner.setForeground(false); owner.setForeground(true); check(!owner.isApproved(backgroundGrant));
    check(owner.claimSigning(backgroundGrant) == null); check(!owner.wasDispatched(backgroundGrant));
    owner.focus(a); var expired = owner.admit(a, 3, SERVER, "image/png"); check(expired != null);
    check(owner.append(expired, 0, body())); var expiredReview = owner.seal(expired);
    var expiredGrant = owner.approve(expired, expiredReview); check(expiredGrant != null);
    time.addAndGet(60_000); check(!owner.isApproved(expiredGrant)); check(owner.claimSigning(expiredGrant) == null);
    var stale = ready(owner, a); owner.revoke(a); check(owner.seal(stale) == null);
    var replacement = owner.register("a", ID); check(replacement != null); check(owner.admit(a, 0, SERVER, "text/plain") == null);
    owner.focus(replacement); var empty = owner.admit(replacement, 0, SERVER, "text/plain"); var emptyReview = owner.seal(empty);
    check(emptyReview != null && emptyReview.sha256.equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")); owner.cancel(empty);
    var longReview = ready(owner, replacement); time.addAndGet(600_000); check(owner.preview(longReview, emptyReview) == null);
    var rollback = ready(owner, replacement); time.decrementAndGet(); check(owner.seal(rollback) == null);
    check(owner.admit(replacement, 0, SERVER, "text/plain") == null);
    owner.revokeAll(); check(owner.register("after-clock-failure", ID) == null);
    System.out.println("{\"language\":\"Java\",\"uploadAuthorityChecks\":"+checks+",\"failed\":0}");
  }
}
