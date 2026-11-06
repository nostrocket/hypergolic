import org.nostrocket.hypergolic.host.CapabilityLeaseRegistry;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.ArrayList;
import java.util.List;

public final class CapabilityLeaseProof {
  private static int checks = 0;
  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
    checks++;
  }
  private static void waitingAdmission() {
    AtomicLong clock = new AtomicLong(1000);
    CapabilityLeaseRegistry owner = new CapabilityLeaseRegistry(clock::get);
    owner.register("first"); owner.register("second");
    List<String> active = new ArrayList<>();
    for (int sequence = 1; sequence <= 4; sequence++) active.add(owner.admit("first", sequence, "held"));
    String set = owner.enqueue("first", 5, "storage.set:k=v");
    String get = owner.enqueue("first", 6, "storage.get:k");
    String remove = owner.enqueue("first", 7, "storage.remove:k");
    String other = owner.enqueue("second", 1, "other view");
    check(owner.retained(set) && owner.take(set) == null && owner.borrowedSnapshot(set) == null, "waiting does not authorize work");
    check(owner.promote().equals(List.of(other)), "a full view cannot block another eligible view");
    check(owner.admit("first", 8, "fast direct") == null, "waiting does not increase active capacity");
    owner.take(active.get(0)); owner.finish(active.get(0));
    check(owner.promote().equals(List.of(set)), "first waiting storage snapshot");
    check("storage.set:k=v".equals(owner.take(set)) && owner.finish(set), "exact set once");
    check(owner.promote().equals(List.of(get)), "get stays behind set");
    check("storage.get:k".equals(owner.take(get)) && owner.finish(get), "exact get once");
    check(owner.promote().equals(List.of(remove)), "remove stays behind get");
    check("storage.remove:k".equals(owner.take(remove)), "exact remove snapshot");
    String waiting = owner.enqueue("first", 9, "old waiting mutation");
    String unclaimed = owner.enqueue("second", 2, "promoted before background");
    check(owner.promote().equals(List.of(unclaimed)), "other view promoted but not dispatched");
    check(owner.setForeground(false).containsAll(List.of(waiting, remove, unclaimed)), "background invalidates waiting, claimed and promoted-unclaimed phases");
    owner.setForeground(true);
    check(owner.promote().isEmpty() && owner.take(waiting) == null && owner.take(unclaimed) == null &&
        !owner.finish(remove), "resume cannot promote, take or commit old work");
    check(owner.enqueue("first", 9, "replay") == null, "queued sequence was consumed");
    String expired = owner.enqueue("first", 10, "expired set");
    clock.addAndGet(24_999);
    check(owner.promote().equals(List.of(expired)) && owner.take(expired) != null, "late promotion keeps original lease");
    clock.incrementAndGet();
    check(!owner.isActive(expired) && !owner.finish(expired), "promotion does not extend expiry");
    String removed = owner.enqueue("first", 11, "closing view");
    owner.revoke("first");
    check(!owner.retained(removed) && owner.promote().isEmpty(), "close cancels waiting work");

    String stale = owner.enqueue("second", 3, "independent expired set");
    clock.addAndGet(1000);
    String later = owner.enqueue("second", 4, "independent later get");
    clock.addAndGet(24_000);
    check(owner.promote().equals(List.of(later)) && owner.take(stale) == null, "expired write never executes before a later valid request");
    check("independent later get".equals(owner.take(later)), "later independent request retains its own deadline");
  }

  private static void waitingBounds() {
    CapabilityLeaseRegistry owner = new CapabilityLeaseRegistry(() -> 1000);
    owner.register("first"); owner.register("second"); owner.register("third");
    for (int sequence = 1; sequence <= 8; sequence++) {
      check(owner.enqueue("first", sequence, "a") != null, "per-view waiting admit");
      check(owner.enqueue("second", sequence, "b") != null, "process waiting admit");
    }
    check(owner.enqueue("first", 9, "too many") == null, "per-view waiting cap");
    check(owner.enqueue("third", 1, "too many") == null, "process waiting cap");
    check(owner.promote().size() == 8 && owner.promote().isEmpty(), "global active cap is still eight");
    check(owner.admit("third", 2, "fast") == null, "fast path still denies at global cap");

    CapabilityLeaseRegistry bytes = new CapabilityLeaseRegistry(() -> 1000);
    bytes.register("first"); bytes.register("second");
    String half = "🧪".repeat(CapabilityLeaseRegistry.MAX_BYTES / 8);
    check(bytes.enqueue("first", 1, half) != null && bytes.enqueue("second", 1, half) != null, "exact queued UTF-8 byte budget");
    check(bytes.enqueue("second", 2, "overflow") == null, "queued byte budget shared");
    bytes.revoke("first");
    check(bytes.enqueue("second", 3, half) != null, "revoked waiting bytes returned");
  }

  public static void main(String[] args) throws Exception {
    AtomicLong clock = new AtomicLong(1000);
    CapabilityLeaseRegistry leases = new CapabilityLeaseRegistry(clock::get);
    check(leases.register("generation-a"), "register");
    check(!leases.register("generation-a"), "duplicate registration");
    check(!leases.register("bad/path"), "invalid generation");
    check(leases.admit("foreign", 1, "snapshot") == null, "unknown generation");
    check(leases.admit("generation-a", 2, "snapshot") == null, "out-of-order sequence");
    String token = leases.admit("generation-a", 1, "immutable snapshot");
    check(token != null, "admit");
    check(!leases.isActive(token), "unclaimed token");
    check("immutable snapshot".equals(leases.take(token)), "original snapshot");
    check(leases.take(token) == null, "single take");
    check(leases.isActive(token), "claimed token");
    check(leases.finish(token), "complete once");
    check(!leases.finish(token) && !leases.isActive(token), "no reuse");
    check(leases.admit("generation-a", 1, "changed") == null, "transport replay");
    String expires = leases.admit("generation-a", 2, "expiry");
    leases.take(expires); clock.addAndGet(24_999);
    check(leases.isActive(expires), "before exact expiry");
    clock.incrementAndGet();
    check(!leases.isActive(expires) && !leases.finish(expires), "exact native expiry");
    String revoked = leases.admit("generation-a", 3, "revoked"); leases.take(revoked); leases.revoke("generation-a");
    check(!leases.sessionActive("generation-a") && !leases.isActive(revoked), "synchronous revocation");
    check(leases.take(revoked) == null && !leases.finish(revoked), "revoked result");

    CapabilityLeaseRegistry bounded = new CapabilityLeaseRegistry(clock::get);
    bounded.register("one"); bounded.register("two"); bounded.register("three");
    ArrayList<String> pending = new ArrayList<>();
    for (int i = 1; i <= 4; i++) { pending.add(bounded.admit("one", i, "x")); check(pending.get(i - 1) != null, "per-view admit"); }
    check(bounded.admit("one", 5, "overflow") == null, "per-view bound");
    for (int i = 1; i <= 4; i++) check(bounded.admit("two", i, "x") != null, "global admit");
    check(bounded.admit("three", 1, "overflow") == null, "global bound");
    bounded.take(pending.get(0)); bounded.finish(pending.get(0));
    check(bounded.admit("one", 6, "after consumed overload") != null, "sequence advances after overload");
    bounded.revoke("two");
    check(bounded.admit("three", 2, "released capacity") != null, "revocation releases capacity");
    clock.addAndGet(25_000);
    check(bounded.admit("three", 3, "expired capacity") != null, "expiry releases capacity");
    check(bounded.admit("three", 4, "🧪".repeat(CapabilityLeaseRegistry.MAX_BYTES / 4 + 1)) == null, "UTF-8 byte bound");
    check(bounded.admit("three", 5, "😀".repeat(CapabilityLeaseRegistry.MAX_BYTES / 4)) != null, "exact UTF-8 boundary");

    CapabilityLeaseRegistry concurrent = new CapabilityLeaseRegistry(clock::get);
    concurrent.register("concurrent"); String race = concurrent.admit("concurrent", 1, "one claimant");
    CountDownLatch start = new CountDownLatch(1); AtomicInteger winners = new AtomicInteger();
    ArrayList<Thread> threads = new ArrayList<>();
    for (int i = 0; i < 16; i++) {
      Thread thread = new Thread(() -> { try { start.await(); if (concurrent.take(race) != null) winners.incrementAndGet(); } catch (InterruptedException error) { throw new AssertionError(error); } });
      threads.add(thread); thread.start();
    }
    start.countDown(); for (Thread thread : threads) thread.join();
    check(winners.get() == 1, "concurrent single-use claim");
    concurrent.revoke("concurrent"); check(!concurrent.finish(race), "concurrent revoke invalidates claimant");
    CapabilityLeaseRegistry sessions = new CapabilityLeaseRegistry(clock::get);
    for (int i = 0; i < 64; i++) check(sessions.register("session-" + i), "session admit");
    check(!sessions.register("session-overflow"), "session bound");
    sessions.revoke("session-0"); check(sessions.register("fresh-generation"), "fresh generation capacity");
    CapabilityLeaseRegistry lifetime = new CapabilityLeaseRegistry(clock::get);
    lifetime.register("loaded");
    String old = lifetime.admit("loaded", 1, "old"); lifetime.take(old);
    String unclaimed = lifetime.admit("loaded", 2, "unclaimed");
    check(lifetime.setForeground(false).size() == 2, "background revokes every pending token");
    check(lifetime.sessionActive("loaded"), "loaded view retained");
    check(lifetime.admit("loaded", 3, "background") == null, "background admission denied and sequence consumed");
    lifetime.setForeground(true);
    check(!lifetime.isActive(old) && lifetime.borrowedSnapshot(old) == null && !lifetime.finish(old), "return cannot resurrect claimed work");
    check(lifetime.take(unclaimed) == null, "return cannot claim old unclaimed work");
    check(lifetime.admit("loaded", 3, "replay") == null, "background sequence cannot replay");
    String fresh = lifetime.admit("loaded", 4, "fresh");
    check("fresh".equals(lifetime.take(fresh)) && lifetime.finish(fresh), "new foreground request succeeds");
    waitingAdmission();
    waitingBounds();
    System.out.println("{\"language\":\"Java\",\"checks\":" + checks + ",\"failed\":0}");
  }
}
