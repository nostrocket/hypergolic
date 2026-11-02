package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Real production transport against disposable TLS peers; no runtime/exported fixture route. */
public final class NativeSignerRelayProof {
  private static int checks;
  private static final int MIB = 1024 * 1024;
  private static final String HOST = "relay.example.org";
  private static final LongSupplier CLOCK = () -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime());
  private static final InetAddress LOOPBACK;
  private static final PublishedHttpsTransport.AddressPolicy LOCAL = new PublishedHttpsTransport.AddressPolicy() {
    @Override public boolean isAllowedHost(String host) { return HOST.equals(host); }
    @Override public boolean isAllowedAddress(InetAddress address) { return address.isLoopbackAddress(); }
  };
  static { try { LOOPBACK = InetAddress.getByAddress(new byte[] {127, 0, 0, 1}); }
    catch (IOException impossible) { throw new ExceptionInInitializerError(impossible); } }

  public static void main(String[] args) throws Exception {
    SSLContext server = PublishedHttpsTlsProof.serverContext(Paths.get(args[1]));
    SSLSocketFactory trusted = PublishedHttpsTlsProof.trustedFactory(Paths.get(args[0]));
    ThreadPoolExecutor dns = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
    try {
      canonicalAndLimits();
      budgetBoundaries();
      roundTrip(server, trusted, dns);
      pingAndClose(server, trusted, dns);
      rejectedFrames(server, trusted, dns);
      deniedDispatch(server, trusted, dns);
      cancelledRead(server, trusted, dns, false);
      cancelledRead(server, trusted, dns, true);
      cancelledWrite(server, trusted, dns);
      cancelledOpening(server, trusted, dns);
      rejectsTlsAndDns(server, trusted, dns);
    } finally { dns.shutdownNow(); check(dns.awaitTermination(2, TimeUnit.SECONDS)); }
    System.out.println("NativeSignerRelayProof: " + checks + " checks passed");
  }
  private static NativeSignerRelay.Transport transport(SSLSocketFactory factory, ThreadPoolExecutor dns, LongSupplier clock) {
    return new NativeSignerRelay.Transport(LOCAL, ignored -> new InetAddress[] {LOOPBACK}, dns,
        factory, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER, clock);
  }
  private static NativeSignerRelay open(Peer peer, Control control, NativeSignerRelay.Budget budget,
      SSLSocketFactory factory, ThreadPoolExecutor dns, LongSupplier clock, long deadline) throws IOException {
    return NativeSignerRelay.openWithTransport(peer.url(), control, deadline, budget, transport(factory, dns, clock));
  }
  private static void canonicalAndLimits() throws Exception {
    equal("wss://relay.example.org/nostr", NativeSignerRelay.canonical("wss://relay.example.org/nostr"));
    for (String bad : new String[] {"ws://relay.example.org", "wss://RELAY.example.org", "wss://relay.example.org/",
        "wss://relay.example.org:443", "wss://user@relay.example.org", "wss://relay.example.org?x=1", "wss://127.0.0.1", "wss://relay.example.org/%00"}) {
      rejects(() -> NativeSignerRelay.canonical(bad));
    }
    check(PublishedRelayWebSocketFrames.MAX_BYTES == 66_560);
    check(PublishedRelayWebSocketClientFrames.MAX_TEXT_BYTES == 8_192);
    invalid(() -> PublishedRelayWebSocketClientFrames.textReq("a".repeat(8_193)));
    byte[] big = PublishedRelayWebSocketClientFrames.textReq("a".repeat(65_536), new byte[] {1, 2, 3, 4}, NativeSignerRelay.MAX_BYTES);
    equal(127, big[1] & 127); equal(65_550, big.length);
    invalid(() -> PublishedRelayWebSocketClientFrames.textReq("a".repeat(8 * MIB - 13), NativeSignerRelay.MAX_BYTES));
    invalid(() -> PublishedRelayWebSocketClientFrames.textReq("\ud800", NativeSignerRelay.MAX_BYTES));
    PublishedRelayWebSocketFrames ordinary = new PublishedRelayWebSocketFrames();
    check(ordinary.feed(header(0x81, 66_560)).stream().anyMatch(e -> "error".equals(e.type)));
    PublishedRelayWebSocketFrames extended = new PublishedRelayWebSocketFrames(NativeSignerRelay.MAX_BYTES);
    check(extended.feed(header(0x81, 8 * MIB)).stream().anyMatch(e -> "error".equals(e.type)));
    check(extended.completedFrameCount() == 0);
    PublishedRelayWebSocketFrames fragments = new PublishedRelayWebSocketFrames(128);
    fragments.feed(frame(0x01, new byte[100]));
    check(fragments.feed(frame(0x80, new byte[29])).stream().anyMatch(e -> "error".equals(e.type)));
  }
  private static void budgetBoundaries() throws Exception {
    NativeSignerRelay.Budget peers = new NativeSignerRelay.Budget();
    peers.admit(42); peers.admit(42); peers.admit(42); rejects(() -> peers.admit(42)); rejects(() -> peers.wire(0));
    NativeSignerRelay.Budget deadline = new NativeSignerRelay.Budget(); deadline.admit(42); rejects(() -> deadline.admit(43));
    NativeSignerRelay.Budget wire = new NativeSignerRelay.Budget(); wire.wire(32 * MIB - 1);
    equal(1, wire.reserveRead(8_192)); wire.finishRead(1, 0); wire.wire(1); rejects(() -> wire.reserveRead(1));
    NativeSignerRelay.Budget frames = new NativeSignerRelay.Budget(); frames.inbound(64, 0); rejects(() -> frames.outbound(1, false));
    NativeSignerRelay.Budget texts = new NativeSignerRelay.Budget(); texts.inbound(32, 32); rejects(() -> texts.outbound(1, true));
    NativeSignerRelay.Budget readCount = new NativeSignerRelay.Budget(); readCount.inbound(63, 0); rejects(() -> readCount.inbound(2, 0));
  }
  private static void roundTrip(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    String text = "x".repeat(6_990_604);
    try (Peer peer = new Peer(server, (in, out) -> {
      equal(text, masked(in, 1)); out.write(frame(0x81, text.getBytes(StandardCharsets.UTF_8))); out.flush();
    }); NativeSignerRelay relay = open(peer, new Control(), new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 15_000)) {
      relay.send(text); equal(text, relay.read()); peer.finished();
    }
  }
  private static void pingAndClose(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    Control control = new Control();
    try (Peer peer = new Peer(server, (in, out) -> {
      out.write(concat(frame(0x89, new byte[] {7}), frame(0x81, new byte[] {'o', 'k'}), frame(0x88, new byte[0]))); out.flush();
      equal("\u0007", masked(in, 10));
    }); NativeSignerRelay relay = open(peer, control, new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 10_000)) {
      equal("ok", relay.read()); rejects(relay::read); equal(0, control.dispatched.get()); peer.finished();
    }
  }
  private static void rejectedFrames(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    byte[] flood = new byte[130]; for (int i = 0; i < 65; i++) { flood[2 * i] = (byte) 0x8a; flood[2 * i + 1] = 0; }
    byte[] fragments = new byte[130]; fragments[0] = 1; for (int i = 1; i < 65; i++) fragments[2 * i] = 0;
    byte[][] negatives = {flood, fragments, header(0x81, 8 * MIB), new byte[] {(byte) 0x81, 2, (byte) 0xc0, (byte) 0xaf},
        new byte[] {(byte) 0x82, 0}, new byte[] {(byte) 0x81, (byte) 0x80, 0, 0, 0, 0},
        concat(frame(0x88, new byte[0]), frame(0x81, new byte[] {'x'})), manyTexts(33)};
    for (byte[] bad : negatives) {
      try (Peer peer = new Peer(server, (in, out) -> { out.write(bad); out.flush(); });
          NativeSignerRelay relay = open(peer, new Control(), new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 10_000)) {
        // Bounds are checked on each complete read; no text is released from an over-budget batch.
        rejects(() -> { for (int i = 0; i < 34; i++) relay.read(); }); peer.finished();
      }
    }
  }
  private static byte[] manyTexts(int count) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); for (int i = 0; i < count; i++) bytes.write(frame(0x81, new byte[0])); return bytes.toByteArray();
  }
  private static void deniedDispatch(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    Control control = new Control(); control.deny = true;
    try (Peer peer = new Peer(server, (in, out) -> { equal(-1, in.read()); });
        NativeSignerRelay relay = open(peer, control, new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 10_000)) {
      rejects(() -> relay.send("secret")); equal(0, control.dispatched.get()); peer.finished();
    }
  }
  private static void cancelledRead(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns, boolean expire) throws Exception {
    AtomicLong clock = new AtomicLong(CLOCK.getAsLong()); long deadline = clock.get() + 10_000;
    Control control = new Control(); CountDownLatch started = new CountDownLatch(1);
    try (Peer peer = new Peer(server, (in, out) -> { started.countDown(); equal(-1, in.read()); });
        NativeSignerRelay relay = open(peer, control, new NativeSignerRelay.Budget(), factory, dns, clock::get, deadline)) {
      FutureTask<Boolean> task = failed(relay::read); Thread worker = launch(task); check(started.await(2, TimeUnit.SECONDS));
      long begin = System.nanoTime(); if (expire) clock.set(deadline); else control.cancelled.set(true);
      check(task.get(2, TimeUnit.SECONDS)); check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin) < 1_000);
      worker.join(2_000); check(!worker.isAlive()); peer.finished();
    }
  }
  private static void cancelledWrite(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    Control control = new Control(); CountDownLatch attached = new CountDownLatch(1), release = new CountDownLatch(1);
    try (Peer peer = new Peer(server, (in, out) -> { attached.countDown(); check(release.await(3, TimeUnit.SECONDS)); });
        NativeSignerRelay relay = open(peer, control, new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 10_000)) {
      check(attached.await(2, TimeUnit.SECONDS));
      FutureTask<Boolean> task = failed(() -> relay.send("x".repeat(8 * MIB - 14))); Thread worker = launch(task);
      check(control.beforeSend.await(2, TimeUnit.SECONDS));
      synchronized (control.authority) { control.cancelled.set(true); control.raw.close(); }
      check(task.get(2, TimeUnit.SECONDS)); worker.join(2_000); check(!worker.isAlive()); equal(1, control.dispatched.get()); release.countDown();
    }
  }
  private static void cancelledOpening(SSLContext server, SSLSocketFactory factory, ThreadPoolExecutor dns) throws Exception {
    Control control = new Control(); CountDownLatch upgrading = new CountDownLatch(1), release = new CountDownLatch(1);
    try (Peer peer = new Peer(server, (in, out) -> {}, upgrading, release)) {
      FutureTask<Boolean> task = failed(() -> open(peer, control, new NativeSignerRelay.Budget(), factory, dns, CLOCK, CLOCK.getAsLong() + 10_000));
      Thread worker = launch(task); check(upgrading.await(2, TimeUnit.SECONDS)); control.cancelled.set(true);
      check(task.get(2, TimeUnit.SECONDS)); worker.join(2_000); check(!worker.isAlive()); release.countDown();
    }
    Control dnsControl = new Control(); CountDownLatch resolving = new CountDownLatch(1), blocked = new CountDownLatch(1);
    NativeSignerRelay.Transport delayed = new NativeSignerRelay.Transport(LOCAL, host -> {
      resolving.countDown(); try { blocked.await(3, TimeUnit.SECONDS); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
      return new InetAddress[] {LOOPBACK};
    }, dns, factory, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER, CLOCK);
    FutureTask<Boolean> task = failed(() -> NativeSignerRelay.openWithTransport("wss://relay.example.org", dnsControl,
        CLOCK.getAsLong() + 10_000, new NativeSignerRelay.Budget(), delayed)); Thread worker = launch(task);
    check(resolving.await(2, TimeUnit.SECONDS)); dnsControl.cancelled.set(true); check(task.get(2, TimeUnit.SECONDS));
    blocked.countDown(); worker.join(2_000); check(!worker.isAlive()); check(dnsControl.raw == null);
  }
  private static void rejectsTlsAndDns(SSLContext server, SSLSocketFactory trusted, ThreadPoolExecutor dns) throws Exception {
    try (Peer peer = new Peer(server, (in, out) -> {})) {
      NativeSignerRelay.Transport mixed = new NativeSignerRelay.Transport(LOCAL, ignored -> new InetAddress[] {
          LOOPBACK, InetAddress.getByAddress(new byte[] {10, 0, 0, 1})}, dns, trusted, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER, CLOCK);
      rejects(() -> NativeSignerRelay.openWithTransport(peer.url(), new Control(), CLOCK.getAsLong() + 10_000, new NativeSignerRelay.Budget(), mixed));
      equal(0, peer.accepted.get());
    }
    try (Peer peer = new Peer(server, (in, out) -> {})) {
      rejects(() -> open(peer, new Control(), new NativeSignerRelay.Budget(), SSLContext.getDefault().getSocketFactory(), dns, CLOCK, CLOCK.getAsLong() + 10_000));
      equal(1, peer.accepted.get()); check(!peer.upgraded);
    }
    try (Peer peer = new Peer(server, (in, out) -> {})) {
      NativeSignerRelay.Transport publicOnly = new NativeSignerRelay.Transport(PublishedHttpsRequestOwner.addressPolicy(),
          ignored -> new InetAddress[] {LOOPBACK}, dns, trusted, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER, CLOCK);
      rejects(() -> NativeSignerRelay.openWithTransport(peer.url(), new Control(), CLOCK.getAsLong() + 10_000, new NativeSignerRelay.Budget(), publicOnly));
      equal(0, peer.accepted.get());
    }
  }
  private static final class Control implements NativeSignerRelay.Control {
    final AtomicBoolean cancelled = new AtomicBoolean(); final AtomicInteger dispatched = new AtomicInteger();
    final CountDownLatch beforeSend = new CountDownLatch(1); final Object authority = new Object(); volatile Socket raw; boolean deny;
    @Override public boolean isCancelled() { return cancelled.get(); }
    @Override public void attach(Socket socket) throws IOException { raw = socket; socket.setSendBufferSize(1_024); }
    @Override public void beforeSend() throws IOException {
      synchronized (authority) { if (deny || cancelled.get()) throw new IOException("Authority denied"); dispatched.incrementAndGet(); }
      beforeSend.countDown();
    }
  }
  @FunctionalInterface private interface Script { void run(InputStream in, OutputStream out) throws Exception; }
  private static final class Peer implements AutoCloseable {
    final SSLServerSocket listener; final Thread thread; final CountDownLatch done = new CountDownLatch(1), scriptFinished = new CountDownLatch(1);
    final AtomicInteger accepted = new AtomicInteger(); volatile Socket socket; volatile Throwable failure; volatile boolean upgraded;
    Peer(SSLContext context, Script script) throws IOException { this(context, script, null, null); }
    Peer(SSLContext context, Script script, CountDownLatch upgrading, CountDownLatch release) throws IOException {
      listener = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 1, LOOPBACK);
      listener.setSoTimeout(3_000); thread = new Thread(() -> {
        try (SSLSocket client = (SSLSocket) listener.accept()) {
          socket = client; accepted.incrementAndGet(); client.setSoTimeout(10_000); client.startHandshake();
          InputStream in = client.getInputStream(); OutputStream out = client.getOutputStream(); String headers = headers(in);
          if (upgrading != null) { upgrading.countDown(); check(release.await(3, TimeUnit.SECONDS)); return; }
          String key = Arrays.stream(headers.split("\r\n")).filter(line -> line.startsWith("Sec-WebSocket-Key:")).findFirst().orElseThrow().split(":", 2)[1].trim();
          String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
          out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); upgraded = true;
          script.run(in, out); scriptFinished.countDown();
        } catch (Throwable problem) { failure = problem; } finally { done.countDown(); }
      }, "native-signer-relay-peer"); thread.start();
    }
    String url() { return "wss://" + HOST + ":" + listener.getLocalPort() + "/nostr"; }
    void finished() throws Exception { check(scriptFinished.await(3, TimeUnit.SECONDS)); if (failure != null) throw new AssertionError("Peer script failed", failure); }
    @Override public void close() throws IOException {
      listener.close(); Socket active = socket; if (active != null) active.close();
      try { thread.join(2_000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException(interrupted); }
      check(!thread.isAlive());
    }
  }
  private static String headers(InputStream input) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int state = 0;
    while (bytes.size() < 4_096) { int b = input.read(); if (b < 0) throw new IOException("Missing upgrade"); bytes.write(b);
      state = b == new byte[] {13, 10, 13, 10}[state] ? state + 1 : b == 13 ? 1 : 0;
      if (state == 4) return bytes.toString(StandardCharsets.US_ASCII); }
    throw new IOException("Oversized upgrade");
  }
  private static String masked(InputStream input, int opcode) throws IOException {
    DataInputStream data = new DataInputStream(input); equal(0x80 | opcode, data.readUnsignedByte()); int b = data.readUnsignedByte(); check((b & 128) != 0);
    long length = b & 127; if (length == 126) length = data.readUnsignedShort(); else if (length == 127) length = data.readLong();
    check(length >= 0 && length <= NativeSignerRelay.MAX_BYTES); byte[] mask = new byte[4], payload = new byte[(int) length]; data.readFully(mask); data.readFully(payload);
    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; return new String(payload, StandardCharsets.UTF_8);
  }
  private static byte[] header(int opcode, int length) {
    int ext = length <= 125 ? 0 : length <= 65_535 ? 2 : 8; byte[] bytes = new byte[2 + ext]; bytes[0] = (byte) opcode;
    bytes[1] = (byte) (ext == 0 ? length : ext == 2 ? 126 : 127);
    for (int i = 0; i < ext; i++) bytes[2 + i] = (byte) ((long) length >>> ((ext - i - 1) * 8)); return bytes;
  }
  private static byte[] frame(int opcode, byte[] payload) { return concat(header(opcode, payload.length), payload); }
  private static byte[] concat(byte[]... arrays) { int length = 0; for (byte[] bytes : arrays) length += bytes.length; byte[] all = new byte[length]; int offset = 0;
    for (byte[] bytes : arrays) { System.arraycopy(bytes, 0, all, offset, bytes.length); offset += bytes.length; } return all; }
  @FunctionalInterface private interface Action { void run() throws Exception; }
  private static FutureTask<Boolean> failed(Action action) { return new FutureTask<>(() -> { try { action.run(); return false; } catch (IOException expected) { return true; } }); }
  private static Thread launch(FutureTask<Boolean> task) { Thread thread = new Thread(task, "native-signer-relay-worker"); thread.start(); return thread; }
  private static void rejects(Action action) throws Exception { try { action.run(); } catch (IOException expected) { checks++; return; } throw new AssertionError("Expected IOException"); }
  private static void invalid(Action action) throws Exception { try { action.run(); } catch (IllegalArgumentException expected) { checks++; return; } throw new AssertionError("Expected IllegalArgumentException"); }
  private static synchronized void check(boolean value) { if (!value) throw new AssertionError("Condition failed"); checks++; }
  private static synchronized void equal(Object expected, Object actual) { if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); checks++; }
}
