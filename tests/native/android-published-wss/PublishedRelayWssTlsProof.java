package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.SocketException;
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
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Loopback TLS relay proof of the actual Android WSS handshake and bounded query. */
public final class PublishedRelayWssTlsProof {
  private static final String REQUEST = "[\"REQ\",\"sub-1\",{}]";
  private static final InetAddress LOOPBACK;
  private static int checks;

  static {
    try { LOOPBACK = InetAddress.getByAddress(new byte[] {127, 0, 0, 1}); }
    catch (IOException impossible) { throw new ExceptionInInitializerError(impossible); }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("Expected disposable certificate and PKCS12 paths");
    SSLContext serverContext = PublishedHttpsTlsProof.serverContext(Paths.get(args[1]));
    SSLSocketFactory trusted = PublishedHttpsTlsProof.trustedFactory(Paths.get(args[0]));
    ThreadPoolExecutor dns = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(4), task -> {
          Thread thread = new Thread(task, "published-wss-tls-proof-dns");
          thread.setDaemon(true);
          return thread;
        });
    try {
      acceptsVerifiedRelayAndRetriesVettedAddress(serverContext, trusted, dns);
      try (LocalRelay relay = new LocalRelay(serverContext, Mode.AUTH_ANNOUNCEMENT)) {
        equal(Arrays.asList("[\"AUTH\",\"first\"]", "[\"AUTH\",\"rotated\"]", "[\"EOSE\",\"sub-1\"]"),
            query(relay, "relay.example.org", null, ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
        equal(REQUEST, relay.clientRequest);
        equal(1, relay.accepted);
      }
      rejectsUntrustedCertificate(serverContext, dns);
      rejectsWrongHostname(serverContext, trusted, dns);
      rejectsMixedDnsBeforeConnect(serverContext, trusted, dns);
      rejectsRedirect(serverContext, trusted, dns);
      rejectsBadUpgrade(serverContext, trusted, dns);
      rejectsOversizedFrame(serverContext, trusted, dns);
      cancelsAfterUpgrade(serverContext, trusted, dns);
    } finally {
      dns.shutdownNow();
      check(dns.awaitTermination(2, TimeUnit.SECONDS));
    }
    System.out.println("PublishedRelayWssTlsProof: " + checks + " checks passed");
  }

  private static void acceptsVerifiedRelayAndRetriesVettedAddress(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.VALID)) {
      List<String> result = query(relay, "relay.example.org", null, ignored -> new InetAddress[] {
          InetAddress.getByAddress(new byte[] {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}), LOOPBACK
      }, dns, trusted);
      equal(Arrays.asList("event", "eose"), result);
      equal(1, relay.accepted);
      equal(REQUEST, relay.clientRequest);
      check(relay.upgrade.startsWith("GET /nostr HTTP/1.1\r\nHost: relay.example.org:" + relay.port()));
      check(relay.responseFlushed.await(2, TimeUnit.SECONDS));
      check(relay.frameFlushed.await(2, TimeUnit.SECONDS));
    }
  }

  private static void rejectsUntrustedCertificate(SSLContext context, ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.VALID)) {
      throwsIo(() -> query(relay, "relay.example.org", null, ignored -> new InetAddress[] {LOOPBACK},
          dns, SSLContext.getDefault().getSocketFactory()));
      equal(1, relay.accepted);
      equal("", relay.upgrade);
    }
  }

  private static void rejectsWrongHostname(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.VALID)) {
      throwsIo(() -> query(relay, "other.example.org", null,
          ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      equal(1, relay.accepted);
      equal("", relay.upgrade);
    }
  }

  private static void rejectsMixedDnsBeforeConnect(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.VALID)) {
      throwsIo(() -> query(relay, "relay.example.org", null, ignored -> new InetAddress[] {
          LOOPBACK, InetAddress.getByAddress(new byte[] {10, 0, 0, 1})
      }, dns, trusted));
      equal(0, relay.accepted);
    }
  }

  private static void rejectsRedirect(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.REDIRECT)) {
      throwsIo(() -> query(relay, "relay.example.org", null,
          ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      check(!relay.upgrade.isEmpty());
      check(relay.responseFlushed.await(2, TimeUnit.SECONDS));
      equal("", relay.clientRequest);
    }
  }

  private static void rejectsBadUpgrade(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.BAD_ACCEPT)) {
      throwsIo(() -> query(relay, "relay.example.org", null,
          ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      check(!relay.upgrade.isEmpty());
      check(relay.responseFlushed.await(2, TimeUnit.SECONDS));
      equal("", relay.clientRequest);
    }
  }

  private static void rejectsOversizedFrame(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalRelay relay = new LocalRelay(context, Mode.OVERSIZED_FRAME)) {
      throwsIo(() -> query(relay, "relay.example.org", null,
          ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      equal(REQUEST, relay.clientRequest);
      check(relay.frameFlushed.await(2, TimeUnit.SECONDS));
    }
  }

  private static void cancelsAfterUpgrade(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    AtomicBoolean cancelled = new AtomicBoolean();
    try (LocalRelay relay = new LocalRelay(context, Mode.HOLD_RESPONSE)) {
      FutureTask<Boolean> result = new FutureTask<>(() -> {
        try {
          query(relay, "relay.example.org", cancelled::get,
              ignored -> new InetAddress[] {LOOPBACK}, dns, trusted);
          return false;
        } catch (IOException expected) { return true; }
      });
      Thread worker = new Thread(result, "published-wss-tls-proof-cancel");
      worker.setDaemon(true);
      worker.start();
      check(relay.requestArrived.await(2, TimeUnit.SECONDS));
      long started = System.nanoTime();
      cancelled.set(true);
      check(result.get(2, TimeUnit.SECONDS));
      check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1_000);
    }
  }

  private static List<String> query(LocalRelay relay, String host,
      PublishedHttpsTransport.Cancellation cancellation, PublishedHttpsTransport.HostResolver resolver,
      ThreadPoolExecutor dns, SSLSocketFactory factory) throws IOException {
    PublishedHttpsTransport.AddressPolicy proofPolicy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String value) { return value.equals(host); }
      @Override public boolean isAllowedAddress(InetAddress value) { return value.isLoopbackAddress(); }
    };
    return PublishedRelayWssQuery.queryWithTransport("wss://" + host + ":" + relay.port() + "/nostr",
        REQUEST, proofPolicy, cancellation,
        text -> relay.mode == Mode.AUTH_ANNOUNCEMENT ? new PublishedRelayResponseClassifier("sub-1").classify(text) :
            "event".equals(text) ? PublishedRelayWssQuery.TextKind.EVENT :
            "eose".equals(text) ? PublishedRelayWssQuery.TextKind.EOSE : PublishedRelayWssQuery.TextKind.OTHER,
        resolver, dns, factory, PublishedHttpsTlsProof.PROOF_HOSTNAME_VERIFIER);
  }

  private enum Mode { VALID, AUTH_ANNOUNCEMENT, REDIRECT, BAD_ACCEPT, OVERSIZED_FRAME, HOLD_RESPONSE }

  private static final class LocalRelay implements AutoCloseable {
    private final SSLServerSocket listener;
    private final Thread thread;
    private final Mode mode;
    private final CountDownLatch release = new CountDownLatch(1);
    final CountDownLatch requestArrived = new CountDownLatch(1);
    final CountDownLatch responseFlushed = new CountDownLatch(1);
    final CountDownLatch frameFlushed = new CountDownLatch(1);
    volatile int accepted;
    volatile String upgrade = "";
    volatile String clientRequest = "";

    LocalRelay(SSLContext context, Mode mode) throws IOException {
      this.mode = mode;
      listener = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 1, LOOPBACK);
      listener.setSoTimeout(3_000);
      thread = new Thread(this::serve, "published-wss-tls-proof-relay");
      thread.setDaemon(true);
      thread.start();
    }

    int port() { return listener.getLocalPort(); }

    private void serve() {
      try (SSLSocket client = (SSLSocket) listener.accept()) {
        accepted++;
        client.setSoTimeout(3_000);
        client.startHandshake();
        InputStream input = client.getInputStream();
        OutputStream output = client.getOutputStream();
        upgrade = readHeaders(input);
        if (mode == Mode.REDIRECT) {
          output.write("HTTP/1.1 302 Found\r\nLocation: wss://other.example.org/\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        } else {
          String key = header(upgrade, "Sec-WebSocket-Key");
          String accept = mode == Mode.BAD_ACCEPT ? "wrong" : accept(key);
          output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
              "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
              .getBytes(StandardCharsets.US_ASCII));
        }
        output.flush();
        responseFlushed.countDown();
        if (mode == Mode.REDIRECT || mode == Mode.BAD_ACCEPT) return;
        clientRequest = readMaskedText(input);
        requestArrived.countDown();
        if (mode == Mode.HOLD_RESPONSE) {
          release.await(3, TimeUnit.SECONDS);
          return;
        }
        if (mode == Mode.OVERSIZED_FRAME) {
          output.write(new byte[] {(byte) 0x81, 0x7f, 0, 0, 0, 0, 0, 1, 4, 1});
        } else if (mode == Mode.AUTH_ANNOUNCEMENT) {
          output.write(frame("[\"AUTH\",\"first\"]"));
          output.write(frame("[\"AUTH\",\"rotated\"]"));
          output.write(frame("[\"EOSE\",\"sub-1\"]"));
        } else {
          output.write(frame("event"));
          output.write(frame("eose"));
        }
        output.flush();
        frameFlushed.countDown();
      } catch (SocketException expectedWhenClosed) {
        // Listener closure and cancelled clients are expected in negative cases.
      } catch (Exception expectedForNegativeCase) {
        // Caller asserts which phase was reached and whether the client rejected it.
      }
    }

    @Override public void close() throws IOException {
      release.countDown();
      listener.close();
      try { thread.join(2_000); }
      catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new IOException("Interrupted waiting for disposable relay", interrupted);
      }
      check(!thread.isAlive());
    }
  }

  private static String readHeaders(InputStream input) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    while (bytes.size() < 4_096) {
      int value = input.read();
      if (value < 0) throw new IOException("Client closed before upgrade");
      bytes.write(value);
      if (new String(bytes.toByteArray(), StandardCharsets.US_ASCII).endsWith("\r\n\r\n")) {
        return new String(bytes.toByteArray(), StandardCharsets.US_ASCII);
      }
    }
    throw new IOException("Oversized client upgrade");
  }

  private static String header(String headers, String name) throws IOException {
    for (String line : headers.split("\r\n")) {
      if (line.regionMatches(true, 0, name + ":", 0, name.length() + 1)) {
        return line.substring(name.length() + 1).trim();
      }
    }
    throw new IOException("Missing client header " + name);
  }

  private static String accept(String key) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-1").digest(
        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII));
    return Base64.getEncoder().encodeToString(digest);
  }

  private static String readMaskedText(InputStream input) throws IOException {
    int first = input.read(), second = input.read();
    if (first != 0x81 || second < 0 || (second & 0x80) == 0 || (second & 0x7f) > 125) {
      throw new IOException("Invalid client REQ frame");
    }
    int length = second & 0x7f;
    byte[] mask = new byte[4], payload = new byte[length];
    DataInputStream framed = new DataInputStream(input);
    framed.readFully(mask);
    framed.readFully(payload);
    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return new String(payload, StandardCharsets.UTF_8);
  }

  private static byte[] frame(String text) {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    byte[] frame = new byte[2 + bytes.length];
    frame[0] = (byte) 0x81;
    frame[1] = (byte) bytes.length;
    System.arraycopy(bytes, 0, frame, 2, bytes.length);
    return frame;
  }

  private interface IoAction { void run() throws Exception; }
  private static void throwsIo(IoAction action) throws Exception {
    try { action.run(); }
    catch (IOException expected) { checks++; return; }
    throw new AssertionError("Expected IOException");
  }
  private static void equal(Object expected, Object actual) {
    if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    checks++;
  }
  private static void check(boolean value) {
    if (!value) throw new AssertionError("Condition failed");
    checks++;
  }
}
