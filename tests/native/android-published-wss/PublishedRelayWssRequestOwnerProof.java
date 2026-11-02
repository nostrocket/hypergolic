package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Owner lifecycle proof using a fake query, without opening a network connection. */
public final class PublishedRelayWssRequestOwnerProof {
  private static int checks;
  private static final String URL = "wss://relay.example.org";
  private static final String REQ = "[\"REQ\",\"sub-1\",{}]";

  public static void main(String[] args) throws Exception {
    cancellationAndIdempotence();
    concurrencyCap();
    System.out.println("PublishedRelayWssRequestOwnerProof: " + checks + " checks passed");
  }

  private static void cancellationAndIdempotence() throws Exception {
    PublishedRelayWssRequestOwner owner = new PublishedRelayWssRequestOwner(
        (url, req, id, cancellation) -> Collections.singletonList("[\"EOSE\",\"sub-1\"]"));
    String id = uuid();
    rejects(() -> owner.query(id, URL, REQ, "sub-1", () -> true));
    owner.setForeground(true);
    equal(1, owner.query(id, URL, REQ, "sub-1", () -> true).size());
    rejects(() -> owner.query(id, URL, REQ, "sub-1", () -> true));
    check(!owner.cancel(id));
    rejects(() -> owner.query(uuid(), URL, "[\"REQ\",\"wrong\",{}]", "sub-1", () -> true));
    String cancelledBeforeRegister = uuid();
    check(owner.cancel(cancelledBeforeRegister));
    rejects(() -> owner.query(cancelledBeforeRegister, URL, REQ, "sub-1", () -> true));

    CountDownLatch entered = new CountDownLatch(1);
    AtomicReference<Throwable> backgroundResult = new AtomicReference<>();
    PublishedRelayWssRequestOwner waiting = new PublishedRelayWssRequestOwner((url, req, sub, cancellation) -> {
      entered.countDown();
      awaitCancellation(cancellation);
      return Collections.singletonList("late result");
    });
    waiting.setForeground(true);
    String pending = uuid();
    Thread call = new Thread(() -> {
      try { waiting.query(pending, URL, REQ, "sub-1", () -> true); }
      catch (Throwable failure) { backgroundResult.set(failure); }
    });
    call.start();
    check(entered.await(1, TimeUnit.SECONDS));
    waiting.setForeground(false);
    call.join(2_500L);
    check(!call.isAlive());
    check(backgroundResult.get() instanceof IOException);
    checks++;

    String revokeId = uuid();
    AtomicReference<Throwable> revokedResult = new AtomicReference<>();
    CountDownLatch secondEntered = new CountDownLatch(1);
    PublishedRelayWssRequestOwner revoking = new PublishedRelayWssRequestOwner((url, req, sub, cancellation) -> {
      secondEntered.countDown();
      awaitCancellation(cancellation);
      return Collections.singletonList("late result");
    });
    revoking.setForeground(true);
    Thread revokeCall = new Thread(() -> {
      try { revoking.query(revokeId, URL, REQ, "sub-1", () -> true); }
      catch (Throwable failure) { revokedResult.set(failure); }
    });
    revokeCall.start();
    check(secondEntered.await(1, TimeUnit.SECONDS));
    revoking.revokeAll();
    revokeCall.join(2_500L);
    check(!revokeCall.isAlive());
    check(revokedResult.get() instanceof IOException);
    checks++;
  }

  private static void concurrencyCap() throws Exception {
    CountDownLatch entered = new CountDownLatch(4);
    CountDownLatch release = new CountDownLatch(1);
    ArrayList<Thread> threads = new ArrayList<>();
    PublishedRelayWssRequestOwner owner = new PublishedRelayWssRequestOwner((url, request, id, cancel) -> {
      entered.countDown();
      try { if (!release.await(2, TimeUnit.SECONDS)) throw new IOException("test timeout"); }
      catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException(interrupted); }
      return Collections.singletonList("eose");
    });
    owner.setForeground(true);
    AtomicReference<Throwable> threadFailure = new AtomicReference<>();
    for (int i = 0; i < 4; i++) {
      String sub = "sub-1";
      String operation = uuid();
      Thread thread = new Thread(() -> {
        try { owner.query(operation, URL, REQ, sub, () -> true); }
        catch (Throwable failure) { threadFailure.compareAndSet(null, failure); }
      });
      threads.add(thread);
      thread.start();
    }
    check(entered.await(1, TimeUnit.SECONDS));
    rejects(() -> owner.query(uuid(), URL, REQ, "sub-1", () -> true));
    release.countDown();
    for (Thread thread : threads) thread.join(2_000L);
    for (Thread thread : threads) check(!thread.isAlive());
    check(threadFailure.get() == null);
    checks++;
  }

  private static String uuid() { return UUID.randomUUID().toString(); }
  private static void awaitCancellation(PublishedHttpsTransport.Cancellation cancellation) throws IOException {
    long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
    while (!cancellation.isCancelled() && System.nanoTime() < until) {
      try { Thread.sleep(5L); }
      catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException(interrupted); }
    }
  }
  private static void rejects(IoAction action) throws Exception {
    try { action.run(); throw new AssertionError("Operation unexpectedly accepted"); }
    catch (IOException expected) { checks++; }
  }
  private interface IoAction { void run() throws Exception; }
  private static void check(boolean value) { if (!value) throw new AssertionError("Expected true"); checks++; }
  private static void equal(Object expected, Object actual) {
    if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    checks++;
  }
}
