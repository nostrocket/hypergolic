package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;

/** JVM contract proof for the native Expo HTTPS operation owner. */
public final class PublishedHttpsRequestOwnerProof {
  private static final AtomicInteger assertions = new AtomicInteger();

  public static void main(String[] args) throws Exception {
    enforcesCanonicalUuidAndOneUse();
    capsConcurrentRequestsAndReleasesSlots();
    cancellationAndBackgroundRevokeRunningReads();
    appliesTheProductionAddressPolicy();
    System.out.println("PublishedHttpsRequestOwnerProof: " + assertions.get() + " assertions passed");
  }

  private static void enforcesCanonicalUuidAndOneUse() throws Exception {
    PublishedHttpsRequestOwner owner = new PublishedHttpsRequestOwner((url, cancellation) ->
        "verified bytes".getBytes(StandardCharsets.US_ASCII));
    owner.setForeground(true);
    throwsIo(() -> owner.fetch("not-a-uuid", "https://napplets.example.org/a", () -> true));
    String cancelledBeforeRegistration = UUID.randomUUID().toString();
    check(owner.cancel(cancelledBeforeRegistration));
    throwsIo(() -> owner.fetch(cancelledBeforeRegistration, "https://napplets.example.org/a", () -> true));
    String id = UUID.randomUUID().toString();
    bytes("verified bytes", owner.fetch(id, "https://napplets.example.org/a", () -> true));
    throwsIo(() -> owner.fetch(id, "https://napplets.example.org/a", () -> true));
    check(!owner.cancel(id));
    throwsIo(() -> owner.fetch(UUID.randomUUID().toString().toUpperCase(), "https://napplets.example.org/a", () -> true));
  }

  private static void capsConcurrentRequestsAndReleasesSlots() throws Exception {
    CountDownLatch started = new CountDownLatch(4);
    CountDownLatch release = new CountDownLatch(1);
    PublishedHttpsRequestOwner owner = new PublishedHttpsRequestOwner((url, cancellation) -> {
      started.countDown();
      await(release);
      return new byte[] { 1 };
    });
    owner.setForeground(true);
    Thread[] workers = new Thread[4];
    AtomicReference<Throwable> workerFailure = new AtomicReference<>();
    for (int i = 0; i < workers.length; i++) {
      final String id = UUID.randomUUID().toString();
      workers[i] = new Thread(() -> {
        try { owner.fetch(id, "https://napplets.example.org/a", () -> true); }
        catch (Throwable error) { workerFailure.compareAndSet(null, error); }
      });
      workers[i].start();
    }
    check(started.await(2, TimeUnit.SECONDS));
    String fifth = UUID.randomUUID().toString();
    throwsIo(() -> owner.fetch(fifth, "https://napplets.example.org/a", () -> true));
    release.countDown();
    for (Thread worker : workers) worker.join(2_000);
    check(workerFailure.get() == null);
    equal(1, owner.fetch(fifth, "https://napplets.example.org/a", () -> true)[0]);
  }

  private static void cancellationAndBackgroundRevokeRunningReads() throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch sawCancellation = new CountDownLatch(1);
    PublishedHttpsRequestOwner owner = new PublishedHttpsRequestOwner((url, cancellation) -> {
      started.countDown();
      waitForCancellation(cancellation);
      sawCancellation.countDown();
      throw new IOException("cancelled");
    });
    owner.setForeground(true);
    String cancelled = UUID.randomUUID().toString();
    Thread worker = new Thread(() -> {
      try { owner.fetch(cancelled, "https://napplets.example.org/a", () -> true); }
      catch (IOException expected) { assertions.incrementAndGet(); }
    });
    worker.start();
    check(started.await(2, TimeUnit.SECONDS));
    check(owner.cancel(cancelled));
    check(sawCancellation.await(2, TimeUnit.SECONDS));
    worker.join(2_000);
    check(!worker.isAlive());

    CountDownLatch backgroundStarted = new CountDownLatch(1);
    CountDownLatch backgroundCancelled = new CountDownLatch(1);
    PublishedHttpsRequestOwner backgroundOwner = new PublishedHttpsRequestOwner((url, cancellation) -> {
      backgroundStarted.countDown();
      waitForCancellation(cancellation);
      backgroundCancelled.countDown();
      throw new IOException("cancelled");
    });
    backgroundOwner.setForeground(true);
    Thread backgroundWorker = new Thread(() -> {
      try { backgroundOwner.fetch(UUID.randomUUID().toString(), "https://napplets.example.org/a", () -> true); }
      catch (IOException expected) { assertions.incrementAndGet(); }
    });
    backgroundWorker.start();
    check(backgroundStarted.await(2, TimeUnit.SECONDS));
    backgroundOwner.setForeground(false);
    check(backgroundCancelled.await(2, TimeUnit.SECONDS));
    backgroundWorker.join(2_000);
    check(!backgroundWorker.isAlive());
    throwsIo(() -> backgroundOwner.fetch(UUID.randomUUID().toString(), "https://napplets.example.org/a", () -> true));
  }

  private static void appliesTheProductionAddressPolicy() throws Exception {
    PublishedHttpsTransport.AddressPolicy policy = PublishedHttpsRequestOwner.addressPolicy();
    check(policy.isAllowedHost("napplets.example.org"));
    check(!policy.isAllowedHost("printer.local"));
    check(!policy.isAllowedHost("127.0.0.1"));
    check(policy.isAllowedAddress(InetAddress.getByAddress(new byte[] { 8, 8, 8, 8 })));
    check(!policy.isAllowedAddress(InetAddress.getByAddress(new byte[] { 10, 0, 0, 1 })));
    throwsIo(() -> PublishedHttpsTransport.validateRequest("https://printer.local/a", policy));
    throwsIo(() -> PublishedHttpsTransport.validateRequest("https://127.0.0.1/a", policy));
  }

  private static void await(CountDownLatch latch) throws IOException {
    try { if (!latch.await(2, TimeUnit.SECONDS)) throw new IOException("Timed out in proof"); }
    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
  }
  private static void waitForCancellation(PublishedHttpsTransport.Cancellation cancellation) throws IOException {
    try { while (!cancellation.isCancelled()) Thread.sleep(2); }
    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
  }
  private interface IoAction { void run() throws Exception; }
  private static void throwsIo(IoAction action) throws Exception {
    try { action.run(); }
    catch (IOException expected) { assertions.incrementAndGet(); return; }
    throw new AssertionError("Expected IOException");
  }
  private static void bytes(String expected, byte[] actual) {
    String value = new String(actual, StandardCharsets.US_ASCII);
    if (!expected.equals(value)) throw new AssertionError("Unexpected response bytes: " + value);
    assertions.incrementAndGet();
  }
  private static void equal(int expected, int actual) {
    if (expected != actual) throw new AssertionError("Expected " + expected + ", got " + actual);
    assertions.incrementAndGet();
  }
  private static void check(boolean value) {
    if (!value) throw new AssertionError("Condition failed");
    assertions.incrementAndGet();
  }
}
