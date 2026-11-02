package org.nostrocket.hypergolic.signercore;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.nostrocket.hypergolic.host.ApprovalLeaseRegistry;
import org.nostrocket.hypergolic.identityowner.NativeActionRaceHarness;

/** Deterministic races against production session and authority code, used on JVM and Android ART. */
public final class NativeSessionRaceProof {
  private static int assertions;
  private static void check(boolean accepted) { assertions++; if (!accepted) throw new AssertionError("Native race assertion " + assertions); }
  private static void await(CountDownLatch latch) {
    try { if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("Native race timed out"); }
    catch (InterruptedException failure) { throw new AssertionError(failure); }
  }
  private static void join(Thread value) {
    try { value.join(3000); } catch (InterruptedException failure) { throw new AssertionError(failure); }
    check(!value.isAlive());
  }
  private static void authRace(boolean reading, boolean background) {
    NativeVaultSession session = new NativeVaultSession(); session.activate(() -> true);
    long old = session.beginAction(() -> true);
    NativeActionRaceHarness authority = new NativeActionRaceHarness(reading);
    CountDownLatch authorityHeld = new CountDownLatch(1), releaseEffect = new CountDownLatch(1), revoked = new CountDownLatch(1);
    AtomicInteger writes = new AtomicInteger(); AtomicReference<Throwable> outcome = new AtomicReference<>();
    Thread effect = new Thread(() -> {
      try {
        authority.effect(() -> { authorityHeld.countDown(); await(releaseEffect); }, () -> {
          synchronized (session.lock) { session.requireAction(old, () -> true); writes.incrementAndGet(); }
        });
      } catch (Throwable denied) { outcome.set(denied); }
    });
    effect.start(); await(authorityHeld);
    Thread cancel = new Thread(() -> { session.invalidate(background); revoked.countDown(); authority.revoke(background); });
    cancel.start(); await(revoked);
    if (!background) check(session.beginAction(() -> true) != old); // A new action must never authorize the old callback.
    releaseEffect.countDown(); join(effect); join(cancel);
    check(outcome.get() instanceof RuntimeException); check(writes.get() == 0);
    session.activate(() -> true); check(session.activated);
  }
  private static void sourceRace(boolean background) {
    NativeVaultSession session = new NativeVaultSession(); session.activate(() -> true); long old = session.epoch;
    ApprovalLeaseRegistry registry = new ApprovalLeaseRegistry(() -> 100);
    check(registry.register("native_race_source")); registry.foreground(true); registry.focus("native_race_source", true); registry.resume();
    String token = registry.admit("native_race_source", "immutable native event"); check(token != null);
    check(registry.take(token) != null); Object metadata = new Object(); check(registry.prepareSigning(token, metadata)); check(registry.approve(token));
    CountDownLatch sourceHeld = new CountDownLatch(1), releaseEffect = new CountDownLatch(1), revoked = new CountDownLatch(1);
    AtomicInteger signatures = new AtomicInteger(); AtomicReference<Throwable> outcome = new AtomicReference<>();
    Thread effect = new Thread(() -> {
      synchronized (registry) {
        try {
          check(registry.claimNativeSigning(token, metadata)); sourceHeld.countDown(); await(releaseEffect);
          synchronized (session.lock) { session.require(old, () -> true); signatures.incrementAndGet(); }
        } catch (Throwable denied) { outcome.set(denied); }
      }
    });
    effect.start(); await(sourceHeld);
    Thread cancel = new Thread(() -> { session.invalidate(background); revoked.countDown(); registry.cancel(token); });
    cancel.start(); await(revoked); releaseEffect.countDown(); join(effect); join(cancel);
    check(outcome.get() instanceof NativeVault.Error); check(signatures.get() == 0); check(!registry.isApproved(token));
  }
  private static void staleConfirmation() {
    NativeVaultSession session = new NativeVaultSession(); session.activate(() -> true); long original = session.beginAction(() -> true);
    AtomicInteger revisions = new AtomicInteger(1); CountDownLatch accepted = new CountDownLatch(1), commit = new CountDownLatch(1);
    AtomicReference<Throwable> outcome = new AtomicReference<>();
    Thread nativeButton = new Thread(() -> {
      accepted.countDown(); await(commit);
      try { synchronized (session.lock) { session.require(original, () -> true); revisions.incrementAndGet(); } }
      catch (Throwable denied) { outcome.set(denied); }
    });
    nativeButton.start(); await(accepted); session.invalidate(false); session.beginAction(() -> true); commit.countDown(); join(nativeButton);
    check(outcome.get() instanceof NativeVault.Error); check(revisions.get() == 1);
  }
  public static int run() {
    assertions = 0;
    for (boolean read : new boolean[]{true, false}) for (boolean background : new boolean[]{true, false}) authRace(read, background);
    sourceRace(true); sourceRace(false); staleConfirmation();
    assertions += NativeActionRaceHarness.promptProof();
    return assertions;
  }
  public static void main(String[] args) { System.out.println("Native session/authority race assertions: " + run()); }
}
