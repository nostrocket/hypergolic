package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Test-only route bound at the exact production publish entry, with actual downstream WSS code. */
public final class OwnerTLSRoute {
  private static int port;
  private static final java.util.concurrent.atomic.AtomicInteger CALLS = new java.util.concurrent.atomic.AtomicInteger();
  private static final java.util.concurrent.CountDownLatch FOUR_SENDS = new java.util.concurrent.CountDownLatch(4);
  private static javax.net.ssl.SSLSocketFactory socketFactory;
  private static String mode;
  private static ApprovalLeaseRegistry registry;
  private static AtomicBoolean active;
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
  private OwnerTLSRoute() {}
  static void configure(int value, Path anchor, String scenario, ApprovalLeaseRegistry authority, AtomicBoolean job) throws Exception {
    if (socketFactory != null) throw new AssertionError("Route already configured");
    port = value; socketFactory = PublishedHttpsTlsProof.trustedFactory(anchor); mode = scenario; registry = authority; active = job;
  }
  static int calls() { return CALLS.get(); }
  static boolean awaitFourSends() throws InterruptedException { return FOUR_SENDS.await(5, TimeUnit.SECONDS); }
  static List<String> publish(String reviewedUrl, String event, PublishedRelayWssQuery.PublicationControl original, PublishedRelayWssQuery.TextStopPolicy stop) throws IOException {
    if (!(mode.equals("capacity") ? reviewedUrl.matches("wss://relay\\.damus\\.io/proof-[0-5]") : reviewedUrl.equals("wss://relay.damus.io"))) throw new AssertionError("Unreviewed relay passed owner");
    CALLS.incrementAndGet();
    PublishedHttpsTransport.AddressPolicy policy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String host) { return host.equals("relay.example.org"); }
      @Override public boolean isAllowedAddress(InetAddress address) { return address.isLoopbackAddress(); }
    };
    PublishedRelayWssQuery.PublicationControl control = new PublishedRelayWssQuery.PublicationControl() {
      @Override public boolean isCancelled() { return original.isCancelled(); }
      @Override public void attach(Socket socket) throws IOException { original.attach(socket); }
      @Override public void send(PublishedRelayWssQuery.SendAction action) throws IOException {
        if (mode.equals("revoke-before-send")) registry.foreground(false);
        if (mode.equals("job-cancel-before-send")) active.set(false);
        original.send(() -> {
          action.run();
          if (mode.equals("capacity")) FOUR_SENDS.countDown();
          if (mode.equals("revoke-after-send")) registry.foreground(false);
          if (mode.equals("job-cancel-after-send")) active.set(false);
        });
      }
    };
    return PublishedRelayWssQuery.queryWithTransport("wss://relay.example.org:" + port + "/fixture", event, policy, control, stop,
      host -> new InetAddress[] { InetAddress.getByAddress(new byte[] {127, 0, 0, 1}) }, DNS,
      socketFactory, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER);
  }
  static void verifyOwnerIdle() throws ReflectiveOperationException {
    java.lang.reflect.Field slots = OutboxPublicationOwner.class.getDeclaredField("slots");
    slots.setAccessible(true);
    if (((java.util.concurrent.Semaphore) slots.get(null)).availablePermits() != 4) throw new AssertionError("Owner capacity leaked");
    java.lang.reflect.Field timers = OutboxPublicationOwner.class.getDeclaredField("deadlineCloser");
    timers.setAccessible(true);
    if (!((java.util.concurrent.ScheduledThreadPoolExecutor) timers.get(null)).getQueue().isEmpty()) throw new AssertionError("Owner deadline task leaked");
  }
  static void close() throws InterruptedException {
    DNS.shutdownNow();
    if (!DNS.awaitTermination(2, TimeUnit.SECONDS)) throw new AssertionError("DNS worker leaked");
  }
}
