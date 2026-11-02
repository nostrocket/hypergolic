package org.nostrocket.hypergolic.identityowner;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Compiles against the production authority. Inventory, entropy, clock and OS results are explicit doubles. */
public final class DeletionAuthorityProof {
  private static int assertions;
  private static final String FIRST = key(1), SECOND = key(2), THIRD = key(3);
  private static String key(int n) { return String.format("%064x", n); }
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Native deletion assertion " + assertions); }
  private static void denied(Runnable operation) {
    assertions++;
    try { operation.run(); } catch (DeletionAuthority.Denied expected) { return; }
    throw new AssertionError("Expected native denial at assertion " + assertions);
  }
  private static void await(CountDownLatch latch) {
    try { if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("Latch timed out"); }
    catch (InterruptedException error) { throw new AssertionError(error); }
  }
  private static DeletionAuthority.Inventory inventory(long revision, String selected, Map<String, String> records) {
    return new DeletionAuthority.Inventory("native_vault_0123456789", revision, selected, key(100), records);
  }
  private static final class Rig {
    long time;
    int tokens;
    final AtomicReference<DeletionAuthority.Inventory> current = new AtomicReference<>(inventory(1, SECOND, Map.of(FIRST, key(11), SECOND, key(12))));
    final DeletionAuthority authority = new DeletionAuthority(current::get, () -> time, () -> key(++tokens));
    final String session;
    Rig() { authority.activate(); authority.updateForeground(true); session = authority.beginSettings(SECOND, 1); }
    DeletionAuthority.Attempt begin() { return authority.begin(session, FIRST, SECOND, 1); }
    String approve() { return authority.complete(begin(), true); }
  }
  private static void admissionAndInputs() {
    AtomicInteger reads = new AtomicInteger();
    DeletionAuthority a = new DeletionAuthority(() -> { reads.incrementAndGet(); return null; }, () -> 0, () -> key(1));
    denied(() -> a.beginSettings(SECOND, 1)); check(reads.get() == 0);
    a.activate(); denied(a::activate); denied(() -> a.beginSettings(SECOND, 1));
    a.updateForeground(true);
    for (String bad : new String[] { null, "", " ", "G".repeat(64), key(1) + "\n" }) denied(() -> a.beginSettings(bad, 1));
    for (long bad : new long[] { 0, -1, DeletionAuthority.MAX_REVISION + 1 }) denied(() -> a.beginSettings(SECOND, bad));
    check(reads.get() == 0);
    a.retire(); a.updateForeground(true); denied(() -> a.beginSettings(SECOND, 1)); denied(a::activate);
    for (String bad : new String[] { null, "tiny", "x".repeat(129) }) denied(() -> inventory(1, SECOND, Map.of(FIRST, key(11), SECOND, bad == null ? "invalid" : bad)));
    denied(() -> inventory(1, SECOND, Map.of(FIRST, key(11))));
    denied(() -> inventory(0, SECOND, Map.of(SECOND, key(12))));
    Map<String, String> original = new HashMap<>(Map.of(FIRST, key(11), SECOND, key(12)));
    DeletionAuthority.Inventory captured = inventory(1, SECOND, original);
    original.clear(); check(captured.identities.size() == 2);
    try { captured.identities.clear(); throw new AssertionError("Inventory mutable"); } catch (UnsupportedOperationException expected) { assertions++; }
  }
  private static void exactTargetAndOneUse() {
    Rig r = new Rig();
    denied(() -> r.authority.begin(r.session, SECOND, SECOND, 1));
    denied(() -> r.authority.begin(r.session, THIRD, SECOND, 1));
    denied(() -> r.authority.begin(key(88), FIRST, SECOND, 1));
    denied(() -> r.authority.begin(r.session, FIRST, FIRST, 1));
    denied(() -> r.authority.begin(r.session, FIRST, SECOND, 2));
    DeletionAuthority.Attempt pending = r.begin(); check(r.authority.canPresent(pending)); denied(r::begin);
    String token = r.authority.complete(pending, true);
    check(!r.authority.canPresent(pending)); denied(() -> r.authority.complete(pending, true)); denied(r::begin);
    AtomicInteger erases = new AtomicInteger();
    denied(() -> r.authority.erase(r.session, SECOND, token, target -> erases.incrementAndGet()));
    denied(() -> r.authority.erase(key(88), FIRST, token, target -> erases.incrementAndGet()));
    denied(() -> r.authority.erase(r.session, FIRST, key(88), target -> erases.incrementAndGet()));
    r.authority.assertActive(r.session, FIRST, token);
    r.authority.erase(r.session, FIRST, token, target -> { check(FIRST.equals(target)); erases.incrementAndGet(); });
    check(erases.get() == 1);
    denied(() -> r.authority.assertActive(r.session, FIRST, token));
    denied(() -> r.authority.erase(r.session, FIRST, token, target -> erases.incrementAndGet())); check(erases.get() == 1);
    Rig other = new Rig(); denied(() -> other.authority.complete(pending, true));
  }
  private static void failedAndLateAuthentication() {
    Rig r = new Rig(); DeletionAuthority.Attempt rejected = r.begin();
    denied(() -> r.authority.complete(rejected, false)); denied(() -> r.authority.complete(rejected, true));
    DeletionAuthority.Attempt old = r.begin(); r.authority.cancel(r.session);
    DeletionAuthority.Attempt newer = r.begin(); denied(() -> r.authority.complete(old, true)); check(r.authority.canPresent(newer));
    String token = r.authority.complete(newer, true); r.authority.assertActive(r.session, FIRST, token);
    r.authority.cancel(r.session); denied(() -> r.authority.assertActive(r.session, FIRST, token));
    for (int kind = 0; kind < 4; kind++) {
      Rig fixture = new Rig(); DeletionAuthority.Attempt attempt = fixture.begin();
      invalidate(fixture, kind); check(!fixture.authority.canPresent(attempt));
      denied(() -> fixture.authority.complete(attempt, true));
      fixture.authority.updateForeground(true); denied(fixture::begin);
    }
  }
  private static void invalidate(Rig r, int kind) {
    switch (kind) {
      case 0: r.authority.updateForeground(false); break;
      case 1: r.authority.endSettings(r.session); break;
      case 2: r.authority.vaultWillMutate(); break;
      default: r.authority.retire();
    }
  }
  private static void revokeBeforeEffect() {
    for (int kind = 0; kind < 4; kind++) {
      Rig r = new Rig(); String token = r.approve(); invalidate(r, kind);
      denied(() -> r.authority.erase(r.session, FIRST, token, target -> { throw new AssertionError("Erased after revocation"); }));
    }
    Rig r = new Rig(); String token = r.approve();
    String replacement = r.authority.beginSettings(SECOND, 1);
    r.authority.endSettings(r.session); // Late dismissal cannot close the new session.
    denied(() -> r.authority.assertActive(r.session, FIRST, token));
    DeletionAuthority.Attempt fresh = r.authority.begin(replacement, FIRST, SECOND, 1);
    check(r.authority.canPresent(fresh));
  }
  private static void expiry() {
    Rig r = new Rig(); DeletionAuthority.Attempt auth = r.begin();
    r.time = DeletionAuthority.AUTH_MILLIS - 1; check(r.authority.canPresent(auth));
    r.time++; check(!r.authority.canPresent(auth)); denied(() -> r.authority.complete(auth, true));
    String token = r.approve(); r.time += DeletionAuthority.GRANT_MILLIS - 1;
    r.authority.assertActive(r.session, FIRST, token); r.time++;
    denied(() -> r.authority.erase(r.session, FIRST, token, target -> { throw new AssertionError("Expired erase"); }));
    String newer = r.approve(); check(!newer.equals(token));
    Rig overflow = new Rig(); overflow.time = Long.MAX_VALUE - 1; denied(overflow::begin);
  }
  private static void inventoryChangesAtEachBoundary() {
    for (int boundary = 0; boundary < 3; boundary++) {
      for (int change = 0; change < 4; change++) {
        Rig r = new Rig();
        DeletionAuthority.Attempt attempt = boundary > 0 ? r.begin() : null;
        String token = boundary > 1 ? r.authority.complete(attempt, true) : null;
        switch (change) {
          case 0: r.current.set(inventory(2, FIRST, Map.of(FIRST, key(11), SECOND, key(12)))); break;
          case 1: r.current.set(inventory(1, SECOND, Map.of(FIRST, key(19), SECOND, key(12)))); break;
          case 2: r.current.set(inventory(1, SECOND, Map.of(SECOND, key(12)))); break;
          default: r.current.set(new DeletionAuthority.Inventory("another_vault_0123456789", 1, SECOND, key(100), Map.of(FIRST, key(11), SECOND, key(12))));
        }
        if (boundary == 0) denied(r::begin);
        else if (boundary == 1) denied(() -> r.authority.complete(attempt, true));
        else denied(() -> r.authority.erase(r.session, FIRST, token, target -> { throw new AssertionError("Changed inventory erased"); }));
      }
    }
  }
  private static void uncertainEraseCannotReplay() {
    Rig r = new Rig(); String token = r.approve();
    try { r.authority.erase(r.session, FIRST, token, target -> { throw new IllegalStateException("Test-only I/O failure"); }); throw new AssertionError("Missing failure"); }
    catch (IllegalStateException expected) { assertions++; }
    denied(() -> r.authority.erase(r.session, FIRST, token, target -> { throw new AssertionError("Repeated uncertain erase"); }));
    check(!token.equals(r.approve()));
  }
  private static void unavailablePortsAndFinalExpiry() {
    AtomicReference<DeletionAuthority.Inventory> source = new AtomicReference<>(inventory(1, SECOND, Map.of(FIRST, key(11), SECOND, key(12))));
    AtomicBoolean entropyFails = new AtomicBoolean();
    long[] time = {0}; int[] reads = {0}, tokens = {0};
    DeletionAuthority a = new DeletionAuthority(() -> {
      reads[0]++;
      if (reads[0] == 4) time[0] += DeletionAuthority.GRANT_MILLIS;
      return source.get();
    }, () -> time[0], () -> entropyFails.get() ? "malformed" : key(++tokens[0]));
    a.activate(); a.updateForeground(true); String settings = a.beginSettings(SECOND, 1);
    DeletionAuthority.Attempt first = a.begin(settings, FIRST, SECOND, 1);
    String token = a.complete(first, true);
    denied(() -> a.erase(settings, FIRST, token, target -> { throw new AssertionError("Expired during final inventory read"); }));
    DeletionAuthority.Attempt retry = a.begin(settings, FIRST, SECOND, 1);
    entropyFails.set(true); denied(() -> a.complete(retry, true));
    entropyFails.set(false); denied(() -> a.complete(retry, true));
    DeletionAuthority.Attempt unavailable = a.begin(settings, FIRST, SECOND, 1);
    source.set(null); denied(() -> a.complete(unavailable, true));
    denied(() -> a.begin(settings, FIRST, SECOND, 1));
  }
  private static void lateSettingsOpening() throws Exception {
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    AtomicReference<Throwable> result = new AtomicReference<>();
    DeletionAuthority a = new DeletionAuthority(() -> { entered.countDown(); await(release); return inventory(1, SECOND, Map.of(FIRST, key(11), SECOND, key(12))); }, () -> 0, () -> key(1));
    a.activate(); a.updateForeground(true);
    Thread opening = new Thread(() -> { try { a.beginSettings(SECOND, 1); } catch (Throwable error) { result.set(error); } });
    opening.start(); await(entered); denied(() -> a.beginSettings(SECOND, 1));
    a.updateForeground(false); a.updateForeground(true); release.countDown(); opening.join(3000);
    check(!opening.isAlive() && result.get() instanceof DeletionAuthority.Denied);
  }
  private static void eraseAndRevocationAreOrdered() throws Exception {
    Rig r = new Rig(); String token = r.approve();
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), revoking = new CountDownLatch(1);
    AtomicBoolean retired = new AtomicBoolean(), completed = new AtomicBoolean();
    AtomicReference<Throwable> error = new AtomicReference<>();
    Thread eraser = new Thread(() -> { try { r.authority.erase(r.session, FIRST, token, target -> { entered.countDown(); await(release); }); completed.set(true); } catch (Throwable problem) { error.set(problem); } });
    eraser.start(); await(entered);
    Thread retirement = new Thread(() -> { revoking.countDown(); r.authority.retire(); retired.set(true); });
    retirement.start(); await(revoking); check(!retired.get());
    release.countDown(); eraser.join(3000); retirement.join(3000);
    check(completed.get() && retired.get() && error.get() == null && !eraser.isAlive() && !retirement.isAlive());
    denied(() -> r.authority.assertActive(r.session, FIRST, token));
  }
  private static void runtimeOwnership() {
    IdentityOwnerContextRegistry r = new IdentityOwnerContextRegistry();
    Object context = new Object(), foreign = new Object();
    AtomicInteger revokes = new AtomicInteger();
    check(!r.owns(context)); check(!r.register(context, revokes::incrementAndGet));
    check(r.claim(context, true)); check(r.owns(context)); check(!r.owns(foreign));
    check(!r.register(foreign, revokes::incrementAndGet));
    check(r.register(context, revokes::incrementAndGet)); check(!r.register(context, () -> {}));
    r.retireIfOwned(foreign); check(r.owns(context) && revokes.get() == 0);
    r.retireIfOwned(context); check(!r.owns(context) && revokes.get() == 1);
    r.retireIfOwned(context); check(revokes.get() == 1); check(!r.claim(context, true));
    IdentityOwnerContextRegistry wrongThread = new IdentityOwnerContextRegistry();
    check(!wrongThread.claim(context, false)); check(!wrongThread.claim(context, true));
    IdentityOwnerContextRegistry missing = new IdentityOwnerContextRegistry();
    check(!missing.claim(null, true)); check(!missing.claim(context, true));
    IdentityOwnerContextRegistry duplicate = new IdentityOwnerContextRegistry();
    check(duplicate.claim(context, true)); check(duplicate.register(context, revokes::incrementAndGet));
    check(!duplicate.claim(foreign, true)); check(!duplicate.owns(context) && revokes.get() == 2);
  }
  private static void completionCannotOutliveAuthentication() {
    long[] time = { 0 }; int[] reads = { 0 }, entropy = { 0 };
    DeletionAuthority a = new DeletionAuthority(() -> {
      if (++reads[0] == 3) time[0] = DeletionAuthority.AUTH_MILLIS;
      return inventory(1, SECOND, Map.of(FIRST, key(11), SECOND, key(12)));
    }, () -> time[0], () -> key(++entropy[0]));
    a.activate(); a.updateForeground(true); String session = a.beginSettings(SECOND, 1);
    DeletionAuthority.Attempt attempt = a.begin(session, FIRST, SECOND, 1);
    denied(() -> a.complete(attempt, true));
    denied(() -> a.complete(attempt, true));
    denied(() -> a.eraseAuthorized(FIRST, key(2), key -> { throw new AssertionError("Expired callback erased"); }));
    check(!a.canPresent(attempt));
  }
  private static void exactAttemptCleanup() {
    Rig r = new Rig(); DeletionAuthority.Attempt first = r.begin();
    r.authority.cancelAttempt(first); check(!r.authority.canPresent(first));
    DeletionAuthority.Attempt next = r.begin();
    r.authority.cancelAttempt(first); check(r.authority.canPresent(next));
    String token = r.authority.complete(next, true);
    r.authority.cancelAttempt(first); r.authority.assertActive(r.session, FIRST, token);
    r.authority.cancelAttempt(next); denied(() -> r.authority.assertActive(r.session, FIRST, token));
    String fresh = r.approve(); AtomicInteger erased = new AtomicInteger();
    denied(() -> r.authority.eraseAuthorized(SECOND, fresh, key -> erased.incrementAndGet()));
    r.authority.eraseAuthorized(FIRST, fresh, key -> { check(FIRST.equals(key)); erased.incrementAndGet(); });
    check(erased.get() == 1); denied(() -> r.authority.eraseAuthorized(FIRST, fresh, key -> erased.incrementAndGet()));
  }
  public static void main(String[] args) throws Exception {
    runtimeOwnership(); exactAttemptCleanup(); completionCannotOutliveAuthentication();
    admissionAndInputs(); exactTargetAndOneUse(); failedAndLateAuthentication(); revokeBeforeEffect(); expiry();
    inventoryChangesAtEachBoundary(); uncertainEraseCannotReplay(); unavailablePortsAndFinalExpiry(); lateSettingsOpening(); eraseAndRevocationAreOrdered();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + ",\"scope\":\"Production native authority with explicit inventory/auth/clock doubles; no Android OS authentication or storage effect proof.\"}");
  }
}
