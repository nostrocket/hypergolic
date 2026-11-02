package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** Actual loopback TLS proof; only package-local test inputs permit a private endpoint. */
public final class PublishedHttpsTlsProof {
  private static final char[] PASSWORD = "temporary-proof".toCharArray();
  static final HostnameVerifier PROOF_HOSTNAME_VERIFIER = (hostname, session) -> {
    try {
      X509Certificate leaf = (X509Certificate) session.getPeerCertificates()[0];
      Collection<List<?>> names = leaf.getSubjectAlternativeNames();
      if (names != null) for (List<?> name : names) {
        if (name.size() >= 2 && Integer.valueOf(2).equals(name.get(0)) &&
            hostname.equalsIgnoreCase((String) name.get(1))) return true;
      }
    } catch (Exception invalidCertificate) { return false; }
    return false;
  };
  private static final InetAddress LOOPBACK;
  private static int checks;

  static {
    try { LOOPBACK = InetAddress.getByAddress(new byte[] {127, 0, 0, 1}); }
    catch (IOException impossible) { throw new ExceptionInInitializerError(impossible); }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("Expected disposable certificate and PKCS12 paths");
    SSLSocketFactory trusted = trustedFactory(Paths.get(args[0]));
    SSLContext serverContext = serverContext(Paths.get(args[1]));
    ThreadPoolExecutor dns = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(4), task -> {
          Thread thread = new Thread(task, "published-https-tls-proof-dns");
          thread.setDaemon(true);
          return thread;
        });
    try {
      acceptsVerifiedTlsAndRetriesNextVettedAddress(serverContext, trusted, dns);
      rejectsUntrustedCertificate(serverContext, dns);
      rejectsHostnameMismatch(serverContext, trusted, dns);
      rejectsMixedDnsBeforeConnect(serverContext, trusted, dns);
      rejectsRedirectAfterTls(serverContext, trusted, dns);
      cancelsBlockedResponse(serverContext, trusted, dns);
      boundedResourceRedirects(serverContext, trusted, dns);
    } finally {
      dns.shutdownNow();
      check(dns.awaitTermination(2, TimeUnit.SECONDS));
    }
    System.out.println("PublishedHttpsTlsProof: " + checks + " checks passed");
  }

  private static void acceptsVerifiedTlsAndRetriesNextVettedAddress(SSLContext context,
      SSLSocketFactory trusted, ThreadPoolExecutor dns) throws Exception {
    try (LocalServer server = new LocalServer(context, ok("hello"), false)) {
      byte[] body = fetch(server, "napplets.example.org", null,
          ignored -> new InetAddress[] {InetAddress.getByAddress(new byte[] {
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
          }), LOOPBACK},
          dns, trusted);
      equal("hello", new String(body, StandardCharsets.US_ASCII));
      check(server.requestArrived.await(2, TimeUnit.SECONDS));
      check(server.request.startsWith("GET /artifact HTTP/1.1\r\nHost: napplets.example.org:" + server.port()));
      equal(1, server.accepted);
    }
  }

  private static void rejectsUntrustedCertificate(SSLContext context, ThreadPoolExecutor dns) throws Exception {
    try (LocalServer server = new LocalServer(context, ok("hello"), false)) {
      throwsIo(() -> fetch(server, "napplets.example.org", null, ignored -> new InetAddress[] {LOOPBACK},
          dns, SSLContext.getDefault().getSocketFactory()));
      equal(0, server.requestCount);
      equal(1, server.accepted);
    }
  }

  private static void rejectsHostnameMismatch(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalServer server = new LocalServer(context, ok("hello"), false)) {
      throwsIo(() -> fetch(server, "other.example.org", null, ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      equal(0, server.requestCount);
      equal(1, server.accepted);
    }
  }

  private static void rejectsMixedDnsBeforeConnect(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalServer server = new LocalServer(context, ok("hello"), false)) {
      throwsIo(() -> fetch(server, "napplets.example.org", null, ignored -> new InetAddress[] {
          LOOPBACK, InetAddress.getByAddress(new byte[] {10, 0, 0, 1})
      }, dns, trusted));
      equal(0, server.accepted);
    }
  }

  private static void rejectsRedirectAfterTls(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    try (LocalServer server = new LocalServer(context,
        "HTTP/1.1 302 Found\r\nLocation: https://other.example.org/\r\nContent-Length: 0\r\n\r\n", false)) {
      throwsIo(() -> fetch(server, "napplets.example.org", null, ignored -> new InetAddress[] {LOOPBACK}, dns, trusted));
      check(server.requestArrived.await(2, TimeUnit.SECONDS));
      equal(1, server.requestCount);
    }
  }

  private static void cancelsBlockedResponse(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    AtomicBoolean cancelled = new AtomicBoolean();
    try (LocalServer server = new LocalServer(context, ok("late"), true)) {
      FutureTask<Boolean> request = new FutureTask<>(() -> {
        try {
          fetch(server, "napplets.example.org", cancelled::get,
              ignored -> new InetAddress[] {LOOPBACK}, dns, trusted);
          return false;
        } catch (IOException expected) { return true; }
      });
      Thread worker = new Thread(request, "published-https-tls-proof-cancel");
      worker.setDaemon(true);
      worker.start();
      check(server.requestArrived.await(2, TimeUnit.SECONDS));
      long started = System.nanoTime();
      cancelled.set(true);
      check(request.get(2, TimeUnit.SECONDS));
      check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1_000);
    }
  }

  private static void boundedResourceRedirects(SSLContext context, SSLSocketFactory trusted,
      ThreadPoolExecutor dns) throws Exception {
    PublishedHttpsTransport.AddressPolicy proofPolicy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String host) { return true; }
      @Override public boolean isAllowedAddress(InetAddress address) { return address.isLoopbackAddress() || PublicAddressPolicy.accepts(address.getAddress()); }
    };
    AtomicInteger lookups = new AtomicInteger();
    try (LocalServer last = new LocalServer(context, ok("resource"), false);
         LocalServer first = new LocalServer(context, redirect("https://napplets.example.org:" + last.port() + "/artifact"), false)) {
      byte[] body = resource(first, proofPolicy, host -> {lookups.incrementAndGet();return new InetAddress[]{LOOPBACK};}, dns, trusted);
      equal("resource", new String(body, StandardCharsets.US_ASCII));equal(2,lookups.get());equal(1,first.requestCount);equal(1,last.requestCount);
    }
    try (LocalServer first = new LocalServer(context, redirect("/artifact"), false)) {
      throwsIo(() -> resource(first, proofPolicy, host -> new InetAddress[]{LOOPBACK}, dns, trusted));equal(1,first.requestCount);
    }
    for (String location : new String[]{"http://napplets.example.org/artifact","https://127.0.0.1/artifact","https://user@napplets.example.org/artifact","https://printer.local/artifact"}) {
      try (LocalServer first = new LocalServer(context, redirect(location), false)) {
        AtomicInteger calls = new AtomicInteger();
        throwsIo(() -> resource(first,proofPolicy,host->{calls.incrementAndGet();return new InetAddress[]{LOOPBACK};},dns,trusted));equal(1,calls.get());
      }
    }
    try (LocalServer last = new LocalServer(context, redirect("https://napplets.example.org:1/artifact"), false);
         LocalServer middle = new LocalServer(context, redirect("https://napplets.example.org:" + last.port() + "/artifact"), false);
         LocalServer first = new LocalServer(context, redirect("https://napplets.example.org:" + middle.port() + "/artifact"), false)) {
      AtomicInteger calls = new AtomicInteger();
      throwsIo(() -> resource(first,proofPolicy,host->{calls.incrementAndGet();return new InetAddress[]{LOOPBACK};},dns,trusted));equal(3,calls.get());equal(1,last.requestCount);
    }
    try (LocalServer first = new LocalServer(context, redirect("https://mixed.example.org/artifact"), false)) {
      AtomicInteger calls = new AtomicInteger();
      throwsIo(() -> resource(first,proofPolicy,host->{calls.incrementAndGet();return host.equals("mixed.example.org") ? new InetAddress[]{InetAddress.getByAddress(new byte[]{8,8,8,8}),InetAddress.getByAddress(new byte[]{10,0,0,1})}:new InetAddress[]{LOOPBACK};},dns,trusted));equal(2,calls.get());
    }
  }
  private static String redirect(String location) {return "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 0\r\n\r\n";}
  private static byte[] resource(LocalServer server, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor dns, SSLSocketFactory factory) throws IOException {
    return PublishedHttpsTransport.getResourceWithTransport("https://napplets.example.org:"+server.port()+"/artifact",policy,()->false,resolver,dns,factory,PROOF_HOSTNAME_VERIFIER);
  }

  private static byte[] fetch(LocalServer server, String host, PublishedHttpsTransport.Cancellation cancellation,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor dns, SSLSocketFactory factory) throws IOException {
    PublishedHttpsTransport.AddressPolicy proofPolicy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String value) { return value.equals(host); }
      @Override public boolean isAllowedAddress(InetAddress value) {
        return value.isLoopbackAddress();
      }
    };
    return PublishedHttpsTransport.getWithTransport("https://" + host + ":" + server.port() + "/artifact",
        proofPolicy, cancellation, resolver, dns, factory, PROOF_HOSTNAME_VERIFIER);
  }

  static SSLContext serverContext(Path pkcs12) throws Exception {
    KeyStore keys = KeyStore.getInstance("PKCS12");
    try (InputStream input = Files.newInputStream(pkcs12)) { keys.load(input, PASSWORD); }
    KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    managers.init(keys, PASSWORD);
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(managers.getKeyManagers(), null, null);
    return context;
  }

  static SSLSocketFactory trustedFactory(Path pem) throws Exception {
    KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
    trust.load(null, null);
    try (InputStream input = Files.newInputStream(pem)) {
      trust.setCertificateEntry("disposable-server", CertificateFactory.getInstance("X.509").generateCertificate(input));
    }
    TrustManagerFactory managers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    managers.init(trust);
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, managers.getTrustManagers(), null);
    return context.getSocketFactory();
  }

  private static String ok(String body) {
    return "HTTP/1.1 200 OK\r\nContent-Length: " + body.length() + "\r\n\r\n" + body;
  }

  private static final class LocalServer implements AutoCloseable {
    private final SSLServerSocket listener;
    private final Thread thread;
    private final String response;
    private final boolean waitForRelease;
    final CountDownLatch requestArrived = new CountDownLatch(1);
    private final CountDownLatch releaseResponse = new CountDownLatch(1);
    volatile String request = "";
    volatile int accepted;
    volatile int requestCount;
    volatile Exception failure;

    LocalServer(SSLContext context, String response, boolean waitForRelease) throws IOException {
      this.response = response;
      this.waitForRelease = waitForRelease;
      listener = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 1, LOOPBACK);
      listener.setSoTimeout(3_000);
      thread = new Thread(this::serve, "published-https-tls-proof-server");
      thread.setDaemon(true);
      thread.start();
    }

    int port() { return listener.getLocalPort(); }

    private void serve() {
      try (SSLSocket client = (SSLSocket) listener.accept()) {
        accepted++;
        client.setSoTimeout(3_000);
        client.startHandshake();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        InputStream input = client.getInputStream();
        while (bytes.size() < 4_096) {
          int value = input.read();
          if (value < 0) return;
          bytes.write(value);
          if (new String(bytes.toByteArray(), StandardCharsets.US_ASCII).endsWith("\r\n\r\n")) break;
        }
        request = new String(bytes.toByteArray(), StandardCharsets.US_ASCII);
        requestCount++;
        requestArrived.countDown();
        if (waitForRelease && !releaseResponse.await(3, TimeUnit.SECONDS)) return;
        OutputStream output = client.getOutputStream();
        output.write(response.getBytes(StandardCharsets.US_ASCII));
        output.flush();
      } catch (SocketException expectedWhenClosed) {
        // Closing the listener or a cancelled client is expected in negative cases.
      } catch (Exception expectedForNegativeCase) {
        failure = expectedForNegativeCase;
      }
    }

    @Override public void close() throws IOException {
      releaseResponse.countDown();
      listener.close();
      try { thread.join(2_000); }
      catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new IOException("Interrupted waiting for disposable TLS server", interrupted);
      }
      check(!thread.isAlive());
      if (requestCount > 0 && failure != null && !waitForRelease) {
        throw new IOException("Disposable TLS server failed", failure);
      }
    }
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
