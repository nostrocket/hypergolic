package org.nostrocket.hypergolic.host;

import java.util.List;

public final class TransportProof {
  private static int assertions;
  private static void check(boolean value) {
    assertions++;
    if (!value) throw new AssertionError("Transport assertion " + assertions);
  }

  private static final class Fixture {
    long now;
    final ApprovalLeaseRegistry approvals = new ApprovalLeaseRegistry(() -> now);
    final CapabilityLeaseRegistry capabilities = new CapabilityLeaseRegistry(() -> now);
    Fixture() {
      check(capabilities.register("generation-a"));
      check(approvals.register("generation-a"));
      approvals.foreground(false);
      approvals.foreground(true);
      approvals.focus("generation-a", true);
    }
    String admit(String snapshot) { return approvals.admit("generation-a", snapshot); }
  }

  private static void startupReviewAndLifecycle() {
    Fixture f = new Fixture();
    String token = f.admit("exact approval snapshot");
    check(token != null);
    check(f.approvals.isLive(token) == false);
    check(f.approvals.take(token).equals("exact approval snapshot"));
    check(f.approvals.take(token) == null);
    check(f.approvals.mayReview(token));
    check(f.approvals.approve(token));
    check(f.approvals.isApproved(token));
    check(f.approvals.finish(token));
    check(!f.approvals.isLive(token));
    check(!f.approvals.isApproved(token));

    String cancelled = f.admit("cancelled");
    check(cancelled != null);
    f.approvals.cancel(cancelled);
    check(!f.approvals.isLive(cancelled));
    check(!f.approvals.finish(cancelled));
  }

  private static void dismissPauseAndResume() {
    Fixture f = new Fixture();
    String dismissed = f.admit("dismissed");
    check(dismissed != null);
    check(f.approvals.take(dismissed).equals("dismissed"));
    check(f.approvals.mayReview(dismissed));
    f.approvals.dismiss(dismissed);
    check(!f.approvals.isLive(dismissed));
    String paused = f.admit("paused");
    check(paused != null);
    check(!f.approvals.mayReview(paused));
    f.approvals.resume();
    check(f.approvals.take(paused).equals("paused"));
    check(f.approvals.approve(paused));
    check(f.approvals.finish(paused));
  }

  private static void expiryAndDrain() {
    Fixture f = new Fixture();
    String pending = f.admit("pending");
    String claimed = f.admit("claimed");
    check(pending != null && claimed != null);
    check(f.approvals.take(claimed).equals("claimed"));
    f.now = 599_999;
    check(f.approvals.isLive(claimed));
    f.now = 600_000;
    List<String> expired = f.approvals.drainInvalid();
    check(expired.size() == 2);
    check(expired.contains(pending) && expired.contains(claimed));
    check(!f.approvals.isLive(claimed));
    check(f.approvals.take(pending) == null);
  }

  private static void revokeAndReopenForeignGeneration() {
    Fixture f = new Fixture();
    check(f.approvals.register("generation-b"));
    String old = f.admit("old generation");
    check(old != null);
    f.approvals.revoke("generation-a");
    check(f.approvals.drainInvalid().contains(old));
    check(f.approvals.take(old) == null);
    check(f.approvals.register("generation-a"));
    approvalsForGenerationB(f);
  }

  private static void approvalsForGenerationB(Fixture f) {
    String foreign = f.approvals.admit("generation-b", "foreign generation");
    check(foreign != null);
    check(f.approvals.take(foreign).equals("foreign generation"));
    check(!f.approvals.mayReview(foreign));
    f.approvals.focus("generation-b", true);
    check(f.approvals.mayReview(foreign));
    f.approvals.cancel(foreign);
  }

  private static void sharedSequenceLane() {
    Fixture f = new Fixture();
    // NappletHostView consumes the shared transport sequence before routing approval.
    check(f.capabilities.consumeSequence("generation-a", 1));
    String approval = f.admit("publication snapshot");
    check(approval != null);
    // The consumed sequence cannot be replayed into the ordinary capability lane.
    check(f.capabilities.admit("generation-a", 1, "ordinary replay") == null);
    check(f.capabilities.consumeSequence("generation-a", 2));
    String ordinary = f.capabilities.admit("generation-a", 3, "ordinary request");
    check(ordinary != null);
    check(f.capabilities.take(ordinary).equals("ordinary request"));
    check(f.capabilities.finish(ordinary));
    check(f.approvals.take(approval).equals("publication snapshot"));
    f.approvals.cancel(approval);
  }

  private static void preparedReviewAndAtomicRevocation() throws Exception {
    Fixture f = new Fixture();
    String token = f.approvals.admit("generation-a", "captured outbox request", true);
    check(token != null); check(!f.approvals.prepare(token, new Object()));
    check(f.approvals.take(token).equals("captured outbox request"));
    check(!f.approvals.mayReview(token)); check(!f.approvals.approve(token));
    Object plan = new Object(); check(f.approvals.prepare(token, plan));
    check(!f.approvals.prepare(token, new Object())); check(f.approvals.prepared(token) == plan);
    check(f.approvals.mayReview(token)); check(f.approvals.approve(token));
    check(!f.approvals.prepare(token, new Object()));
    int[] sends = {0}; f.approvals.performApproved(token, () -> sends[0]++); check(sends[0] == 1);
    f.approvals.foreground(false);
    try { f.approvals.performApproved(token, () -> sends[0]++); throw new AssertionError("Revoked send"); }
    catch (java.io.IOException expected) { check(sends[0] == 1); }
    f.approvals.foreground(true); f.approvals.resume();
    try { f.approvals.performApproved(token, () -> sends[0]++); throw new AssertionError("Resumed old send"); }
    catch (java.io.IOException expected) { check(sends[0] == 1); }
  }

  public static void main(String[] args) throws Exception {
    preparedReviewAndAtomicRevocation();
    startupReviewAndLifecycle();
    dismissPauseAndResume();
    expiryAndDrain();
    revokeAndReopenForeignGeneration();
    sharedSequenceLane();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
