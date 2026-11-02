package org.nostrocket.hypergolic.host;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/** Owning source authorities, with explicit monotonic clock and public body fixtures. No OS/UI claim. */
public final class NativeSourceHoldProof {
  private static int assertions;
  private static final String USER = "01".repeat(32);
  private static void check(boolean value) {
    assertions++;
    if (!value) throw new AssertionError("Source hold assertion " + assertions);
  }
  private static ApprovalLeaseRegistry approval(AtomicLong clock) {
    ApprovalLeaseRegistry registry = new ApprovalLeaseRegistry(clock::get);
    check(registry.register("source_hold"));
    registry.foreground(true); registry.focus("source_hold",true); registry.resume();
    return registry;
  }
  private static String approve(ApprovalLeaseRegistry registry, Object metadata) {
    String token=registry.admit("source_hold","exact immutable event");
    check(token!=null); check(registry.take(token)!=null); check(registry.prepareSigning(token,metadata)); check(registry.approve(token));
    return token;
  }
  private static void approvalHold() {
    AtomicLong clock=new AtomicLong(100);
    ApprovalLeaseRegistry registry=approval(clock); Object metadata=new Object(); String token=approve(registry,metadata);
    check(registry.holdSigning(token,metadata,1000)==null);
    check(registry.claimNativeSigning(token,metadata));
    check(registry.holdSigning(token,new Object(),1000)==null);
    NativeSigningHold hold=registry.holdSigning(token,metadata,1000); check(hold!=null);
    check(!registry.isLive(token)); check(!registry.isApproved(token)); check(registry.drainInvalid().isEmpty());
    check(!registry.resumeSigning(token,metadata,hold));
    registry.foreground(false); registry.foreground(false);
    check(registry.signingHeld(token,metadata,hold)); check(!registry.isApproved(token)); check(!registry.isLive(token));
    int[] effects={0};
    try { registry.performApproved(token,()->effects[0]++); throw new AssertionError("Pending effect"); }
    catch (java.io.IOException expected) { check(effects[0]==0); }
    registry.foreground(true); registry.resume();
    check(!registry.isApproved(token)); check(!registry.resumeSigning(token,new Object(),hold));
    check(registry.resumeSigning(token,metadata,hold)); check(registry.isApproved(token)); check(registry.isLive(token));
    String unrelated=registry.admit("source_hold","unrelated immutable event"); check(registry.take(unrelated)!=null);
    check(!registry.mayReview(unrelated));
    registry.foreground(false);
    check(!registry.signingHeld(token,metadata,hold)); check(!registry.isApproved(token)); check(registry.drainInvalid().contains(token));
    registry.foreground(true); registry.resume(); check(registry.mayReview(unrelated));
    registry.cancel(unrelated);
    token=approve(registry,metadata); check(registry.claimNativeSigning(token,metadata));
    hold=registry.holdSigning(token,metadata,200); check(hold!=null); clock.set(200);
    check(!registry.signingHeld(token,metadata,hold)); check(registry.drainInvalid().contains(token));
    token=approve(registry,metadata); check(registry.claimNativeSigning(token,metadata)); hold=registry.holdSigning(token,metadata,300); check(hold!=null);
    registry.focus("source_hold",false); check(!registry.signingHeld(token,metadata,hold));
    registry.focus("source_hold",true); registry.resume();
    token=approve(registry,metadata); check(registry.claimNativeSigning(token,metadata)); hold=registry.holdSigning(token,metadata,300); check(hold!=null);
    registry.cancel(token); check(!registry.resumeSigning(token,metadata,hold));
  }
  private static NativeUploadAuthority.Grant upload(NativeUploadAuthority owner, NativeUploadAuthority.SessionHandle session) {
    byte[] body="public disposable body".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    NativeUploadAuthority.RequestHandle request=owner.admit(session,body.length,"https://blossom.example.org","text/plain"); check(request!=null);
    check(owner.append(request,0,body)); NativeUploadAuthority.Review review=owner.seal(request); check(review!=null);
    NativeUploadAuthority.Grant grant=owner.approve(request,review); check(grant!=null); check(owner.claimSigning(grant)==review);
    return grant;
  }
  private static void uploadHold() {
    AtomicLong clock=new AtomicLong(100); NativeUploadAuthority owner=new NativeUploadAuthority(clock::get);
    NativeUploadAuthority.SessionHandle session=owner.register("upload_hold",USER); check(session!=null);
    owner.setForeground(true); owner.focus(session);
    NativeUploadAuthority.Grant grant=upload(owner,session);
    NativeSigningHold hold=owner.hold(grant,120100); check(hold!=null); check(hold.deadline==60100);
    check(!owner.isApproved(grant)); check(!owner.claimTransfer(grant)); check(owner.dispatch(grant)==null);
    owner.setForeground(false); owner.setForeground(false); check(owner.held(grant,hold)); check(!owner.isApproved(grant));
    owner.setForeground(true); check(!owner.isApproved(grant)); check(owner.resume(grant,hold)); check(owner.isApproved(grant));
    check(owner.claimTransfer(grant)); byte[] sent=owner.dispatch(grant); check(sent!=null); check(new String(sent,java.nio.charset.StandardCharsets.UTF_8).equals("public disposable body"));
    java.util.Arrays.fill(sent,(byte)0); check(owner.dispatch(grant)==null); check(owner.held(grant,hold));
    owner.setForeground(false); check(!owner.isApproved(grant)); owner.setForeground(true);
    grant=upload(owner,session); hold=owner.hold(grant,120100); check(hold!=null); clock.set(60100); check(!owner.held(grant,hold)); check(!owner.resume(grant,hold));
    grant=upload(owner,session); hold=owner.hold(grant,120100); check(hold!=null); owner.clearFocus(session); check(!owner.held(grant,hold));
  }
  private static void fixtureHold() {
    AtomicLong clock=new AtomicLong(100); FixtureReleaseAuthority owner=new FixtureReleaseAuthority(clock::get);
    check(owner.synchronize(USER,1,true)); owner.foreground(true);
    byte[] body="<html>disposable</html>".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    FixtureReleaseAuthority.Entry row=owner.prepare("fixture-hold",body,FixtureReleaseAuthority.hash(body),"https://blossom.example.org","[]"); check(row!=null);
    check(owner.approveUpload(row.token)); check(owner.claimNativeSigning(row.token,row,false));
    NativeSigningHold hold=owner.holdSigning(row.token,row,false,120100); check(hold!=null); check(!owner.uploadApproved(row.token)); check(owner.current(row.token)==null);
    owner.foreground(false); owner.foreground(false); check(owner.synchronize(USER,1,true));
    check(owner.signingHeld(row.token,row,false,hold)); check(owner.current(row.token)==null);
    owner.foreground(true); check(owner.synchronize(USER,1,true)); check(owner.resumeSigning(row.token,row,false,hold)); check(owner.uploadApproved(row.token));
    check(!owner.manifestApproved(row.token)); check(owner.uploads.claimTransfer(row.grant)); byte[] dispatch=owner.uploads.dispatch(row.grant); check(dispatch!=null);
    check(owner.verifyRetrieved(row.token,dispatch)); java.util.Arrays.fill(dispatch,(byte)0);
    check(owner.current(row.token)==row); check(!owner.signingHeld(row.token,row,false,hold));
    check(owner.prepareManifest(row.token,"new separate immutable manifest")); check(!owner.manifestApproved(row.token));
    check(owner.approveManifest(row.token)!=null); check(owner.claimNativeSigning(row.token,row,true));
    hold=owner.holdSigning(row.token,row,true,120100); check(hold!=null); check(owner.current(row.token)==null);
    owner.foreground(false); check(owner.synchronize(USER,1,true)); owner.foreground(true); check(owner.synchronize(USER,1,true));
    check(owner.resumeSigning(row.token,row,true,hold)); check(owner.manifestApproved(row.token)); check(!owner.uploadApproved(row.token));
    owner.foreground(false); check(!owner.signingHeld(row.token,row,true,hold)); check(owner.current(row.token)==null);
  }
  private static void fixtureInvalidation() {
    for (boolean epochChange : new boolean[]{true,false}) {
      FixtureReleaseAuthority owner=new FixtureReleaseAuthority(()->100);
      check(owner.synchronize(USER,1,true)); owner.foreground(true);
      byte[] body="public fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
      FixtureReleaseAuthority.Entry row=owner.prepare("fixture-hold",body,FixtureReleaseAuthority.hash(body),"https://blossom.example.org","[]"); check(row!=null);
      check(owner.approveUpload(row.token)); check(owner.claimNativeSigning(row.token,row,false));
      NativeSigningHold hold=owner.holdSigning(row.token,row,false,120100); check(hold!=null);
      owner.foreground(false);
      check(owner.synchronize(USER,epochChange ? 2 : 1,epochChange));
      owner.foreground(true);
      check(!owner.signingHeld(row.token,row,false,hold)); check(!owner.resumeSigning(row.token,row,false,hold)); check(owner.current(row.token)==null);
    }
  }
  public static int run() {
    assertions=0;
    approvalHold(); uploadHold(); fixtureHold(); fixtureInvalidation();
    return assertions;
  }
  public static void main(String[] args) { System.out.println("{\"status\":\"passed\",\"assertions\":"+run()+"}"); }

}
