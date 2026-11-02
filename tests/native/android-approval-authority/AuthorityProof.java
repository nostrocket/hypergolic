package org.nostrocket.hypergolic.host;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class AuthorityProof {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Approval assertion " + assertions); }
  private static final class Fixture {
    long now;
    final NativeApprovalAuthority authority = new NativeApprovalAuthority(() -> now);
    final NativeApprovalAuthority.SessionHandle session = authority.register("session-a");
    Fixture() { authority.setForeground(true); authority.setFocused(session); }
    NativeApprovalAuthority.RequestHandle request(String value) { return authority.admit(session, value); }
  }
  private static void onceAndExact() {
    Fixture f = new Fixture(); var a = f.authority;
    var first = f.request("exact snapshot"); var second = f.request("second");
    check(a.currentReview().request == first);
    check(a.approve(second) == null);
    var grant = a.approve(first); check(grant != null);
    check(a.currentReview() == null); check(a.approve(first) == null); check(a.approve(second) == null);
    check(a.isApproved(grant)); check(a.take(grant).equals("exact snapshot"));
    check(a.take(grant) == null); check(a.isApproved(grant));
    a.finish(grant); check(!a.isApproved(grant)); check(a.take(grant) == null);
    check(a.currentReview().request == second);
    var next = a.approve(second); check(next != null);
    a.cancel(grant); check(a.isApproved(next));
    a.cancel(first); check(a.isApproved(next));
    a.cancel(next); check(!a.contains(second));
  }
  private static void lifecycle() {
    Fixture f = new Fixture(); var a = f.authority;
    var other = a.register("session-b"); var first = f.request("a1");
    var pending = f.request("a2"); var second = a.admit(other, "b1");
    check(a.currentReview().request == first);
    var grant = a.approve(first); a.take(grant);
    a.setFocused(other); check(!a.isApproved(grant)); check(!a.contains(first)); check(a.contains(pending));
    check(a.currentReview().request == second);
    check(!a.dismiss(pending)); check(a.dismiss(second)); check(a.currentReview() == null);
    a.setFocused(f.session); check(a.currentReview() == null); check(a.resumeReview());
    check(a.currentReview().request == pending);
    var backgrounded = a.approve(pending); var queued = f.request("queued");
    a.setForeground(false); check(!a.isApproved(backgrounded)); check(a.contains(queued));
    check(a.currentReview() == null); check(!a.resumeReview());
    a.setForeground(true); check(a.currentReview() == null); check(a.resumeReview());
    check(a.currentReview().request == queued);
    a.setFocused(null); check(a.currentReview() == null); check(!a.resumeReview());
    a.setFocused(f.session); check(a.currentReview().request == queued);
    a.teardown(f.session); check(!a.contains(queued)); check(a.currentReview() == null);
    check(a.admit(f.session, "stale") == null);
  }
  private static void limitsAndReuse() {
    Fixture f = new Fixture(); var a = f.authority;
    check(a.register("session-a") == null); check(a.register("") == null);
    List<NativeApprovalAuthority.RequestHandle> requests = new ArrayList<>();
    for (int i = 0; i < 4; i++) { var r=f.request("a" + i); check(r != null); requests.add(r); }
    check(f.request("fifth") == null);
    for (int s = 0; s < 3; s++) {
      var session = a.register("more-" + s);
      for (int i = 0; i < 4; i++) check(a.admit(session, "value") != null);
    }
    var fifth = a.register("fifth"); check(a.admit(fifth, "seventeenth") == null);
    a.cancel(requests.get(0)); check(a.admit(fifth, "space-reused") != null);
    a.teardown(f.session); var replacement = a.register("session-a"); check(replacement != null);
    a.setFocused(replacement); var current = a.admit(replacement, "new"); var grant = a.approve(current);
    check(grant != null); a.setFocused(f.session); check(a.isApproved(grant));
    a.teardown(f.session); a.cancel(requests.get(1)); check(a.isApproved(grant));
    check(!a.clearFocused(f.session)); check(a.isApproved(grant));
    Fixture foreign = new Fixture(); a.setFocused(foreign.session); check(a.isApproved(grant));
    a.cancel(foreign.request("foreign")); check(a.isApproved(grant));
    foreign.authority.cancel(grant); check(a.isApproved(grant));
    check(a.admit(foreign.session,"foreign") == null);
  }
  private static void expiryAndBounds() {
    Fixture f = new Fixture(); var a = f.authority;
    var first = f.request("first"); f.now=100; var second=f.request("second");
    f.now=599_999; check(a.currentReview().request == first);
    var grant=a.approve(first); check(a.take(grant).equals("first"));
    f.now=600_000; var expired=a.expire(); check(expired.size()==1);
    check(expired.get(0).request==first && expired.get(0).approval==grant);
    check(!a.isApproved(grant)); check(a.currentReview().request==second);
    f.now=600_100; check(a.currentReview()==null); check(!a.contains(second));
    check(a.admit(f.session,"") == null); check(a.admit(f.session,null) == null);
    check(a.admit(f.session,"x".repeat(NativeApprovalAuthority.MAX_BYTES)) != null);
    check(a.admit(f.session,"x".repeat(NativeApprovalAuthority.MAX_BYTES+1)) == null);
    check(a.admit(f.session,"\u00e9".repeat(NativeApprovalAuthority.MAX_BYTES)) == null);
    Fixture backwards = new Fixture(); var live=backwards.request("live"); backwards.now=1; backwards.authority.contains(live);
    backwards.now=0; check(!backwards.authority.contains(live)); backwards.now=2;
    check(backwards.request("after bad clock") == null);
    NativeApprovalAuthority overflow=new NativeApprovalAuthority(() -> Long.MAX_VALUE);
    check(overflow.admit(overflow.register("large"),"x") == null);
    NativeApprovalAuthority broken=new NativeApprovalAuthority(() -> { throw new IllegalStateException(); });
    check(broken.register("broken") == null);
  }
  private static void raceConsumesOnce() throws Exception {
    Fixture f=new Fixture(); var request=f.request("raced");
    AtomicInteger approved=new AtomicInteger(); CountDownLatch start=new CountDownLatch(1);
    Runnable claim=() -> { try { start.await(); if(f.authority.approve(request)!=null) approved.incrementAndGet(); } catch(InterruptedException e) { throw new RuntimeException(e); } };
    Thread one=new Thread(claim); Thread two=new Thread(claim); one.start();two.start();start.countDown();one.join();two.join();
    check(approved.get()==1);
  }
  public static void main(String[] args) throws Exception {
    onceAndExact(); lifecycle(); limitsAndReuse(); expiryAndBounds(); raceConsumesOnce();
    System.out.println("{\"status\":\"passed\",\"assertions\":"+assertions+"}");
  }
}
