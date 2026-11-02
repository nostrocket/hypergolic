package org.nostrocket.hypergolic.host;

import org.nostrocket.hypergolic.host.PublishedRelayWssIo.DeadlineInput;
import org.nostrocket.hypergolic.host.PublishedRelayWssIo.AbortMonitor;
import org.nostrocket.hypergolic.host.PublishedRelayResponseClassifier.ResponseCollector;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Bounded public-DNS WSS REQ; the trusted caller validates text structure and EOSE. */
public final class PublishedRelayWssQuery {
  public static final int TOTAL_TIMEOUT_MS = 10_000;
  public static final int MAX_EVENTS = 32;
  public static final int MAX_TEXT_MESSAGES = 64;
  public static final int MAX_TEXT_BYTES = 2 * 1024 * 1024;
  private static final int CONNECT_TIMEOUT_MS = 5_000;
  static final int READ_TIMEOUT_MS = 3_000;
  private static final int MAX_URL_CHARS = 2_048;
  private static final int MAX_HANDSHAKE_BYTES = PublishedRelayWebSocketHandshake.MAX_HEADER_BYTES;
  private static final byte[] CRLFCRLF = new byte[] {'\r', '\n', '\r', '\n'};
  static final SecureRandom RANDOM = new SecureRandom();
  static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(4), task -> { Thread thread = new Thread(task, "napplet-relay-dns"); thread.setDaemon(true); return thread; });

  private PublishedRelayWssQuery() {}
  /** Returns complete text messages through caller-validated EOSE matching the subscription id. */
  public static List<String> query(String rawUrl, String request, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.Cancellation cancellation, TextStopPolicy shouldStop) throws IOException {
    return queryWithTransport(rawUrl, request, policy, cancellation, shouldStop,
        InetAddress::getAllByName, DNS, defaultFactory(), HttpsURLConnection.getDefaultHostnameVerifier());
  }

  @FunctionalInterface interface SendAction { void run() throws IOException; }
  interface PublicationControl extends PublishedHttpsTransport.Cancellation {
    default void attach(Socket socket) throws IOException {}
    void send(SendAction action) throws IOException;
  }
  /** App-only exact EVENT path retains the public DNS/TLS policy. */
  static List<String> publish(String url, String event, PublicationControl control, TextStopPolicy stop) throws IOException {
    return queryWithTransport(url, event, PublishedHttpsRequestOwner.addressPolicy(), control, stop,
        InetAddress::getAllByName, DNS, defaultFactory(), HttpsURLConnection.getDefaultHostnameVerifier());
  }
  /** Package-local inputs allow a controlled host-JVM TLS relay without changing the public query path. */
  static List<String> queryWithTransport(String rawUrl, String request, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.Cancellation cancellation, TextStopPolicy shouldStop,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor executor,
      SSLSocketFactory socketFactory, HostnameVerifier hostnameVerifier) throws IOException {
    RelayUrl relay = parseUrl(rawUrl);
    if (policy == null || shouldStop == null) throw new IllegalArgumentException("Missing relay policy");
    if (!policy.isAllowedHost(relay.host)) throw new IOException("Unsafe relay hostname");
    if (request == null || request.isEmpty()) throw new IOException("Missing relay request");
    byte[] requestFrame;
    try { requestFrame = PublishedRelayWebSocketClientFrames.textReq(request); }
    catch (IllegalArgumentException invalid) { throw new IOException("Invalid bounded relay request", invalid); }

    Deadline deadline = Deadline.start();
    AbortMonitor abort = new AbortMonitor(cancellation, deadline);
    try {
      InetAddress[] addresses = resolve(relay.host, deadline, abort, resolver, executor);
      addresses = PublishedHttpsTransport.checkedAddresses(addresses, policy);
      SSLSocket tls = connect(relay, addresses, policy, abort, deadline, socketFactory, hostnameVerifier);
      try (SSLSocket closeable = tls) {
        DeadlineInput input = new DeadlineInput(closeable.getInputStream(), closeable, deadline);
        OutputStream output = closeable.getOutputStream();
        byte[] nonce = new byte[16];
        RANDOM.nextBytes(nonce);
        sendHandshake(output, relay, nonce);
        byte[] headers = readHandshake(input, abort);
        try { PublishedRelayWebSocketHandshake.validate(headers, nonce); }
        catch (IllegalArgumentException invalid) { throw new IOException("Relay rejected WebSocket upgrade", invalid); }
        abort.check();
        if (cancellation instanceof PublicationControl) {
          ((PublicationControl) cancellation).send(() -> { output.write(requestFrame); output.flush(); });
        } else { output.write(requestFrame); output.flush(); }
        return readMessages(input, output, abort, shouldStop);
      }
    } finally { abort.close(); }
  }
  /** Persistent read uses the same vetted DNS, TLS, handshake and frame policy; EOSE ends only admission. */
  public interface StreamControl extends PublishedHttpsTransport.Cancellation {
    void attach(Socket socket) throws IOException;
    void text(String text) throws IOException;
  }
  public static void stream(String rawUrl, String request, String subscriptionId,
      PublishedHttpsTransport.AddressPolicy policy, StreamControl control) throws IOException {
    PublishedRelayResponseClassifier.validateRequest(request, subscriptionId);
    RelayUrl relay = parseUrl(rawUrl);
    if (!policy.isAllowedHost(relay.host)) throw new IOException("Unsafe relay hostname");
    byte[] requestFrame = PublishedRelayWebSocketClientFrames.textReq(request);
    Deadline deadline = Deadline.start();
    AbortMonitor abort = new AbortMonitor(control, deadline);
    try {
      InetAddress[] addresses = checkedAddresses(resolve(relay.host, deadline, abort, InetAddress::getAllByName, DNS), policy);
      try (SSLSocket tls = connect(relay, addresses, policy, abort, deadline, defaultFactory(), HttpsURLConnection.getDefaultHostnameVerifier())) {
        DeadlineInput input = new DeadlineInput(tls.getInputStream(), tls, deadline);
        OutputStream output = tls.getOutputStream();
        byte[] nonce = new byte[16]; RANDOM.nextBytes(nonce);
        sendHandshake(output, relay, nonce);
        PublishedRelayWebSocketHandshake.validate(readHandshake(input, abort), nonce);
        output.write(requestFrame); output.flush();
        PublishedRelayWebSocketFrames frames = new PublishedRelayWebSocketFrames();
        PublishedRelayResponseClassifier classifier = new PublishedRelayResponseClassifier(subscriptionId);
        byte[] buffer = new byte[PublishedRelayWebSocketFrames.MAX_READ];
        long window = System.nanoTime(); int frameCount = 0, wireBytes = 0;
        while (true) {
          abort.check();
          int count;
          try { count = input.read(buffer); }
          catch (SocketTimeoutException idle) { if (deadline.persistent) continue; throw idle; }
          if (count < 0) throw new IOException("Relay stream closed");
          long current = System.nanoTime();
          if (current - window >= 1_000_000_000L) { window = current; frameCount = 0; wireBytes = 0; }
          wireBytes += count;
          if (wireBytes > 2 * 1024 * 1024) throw new IOException("Relay stream byte rate exceeded");
          byte[] chunk = java.util.Arrays.copyOf(buffer, count);
          List<PublishedRelayWebSocketFrames.Event> batch = frames.feed(chunk);
          if (batch.size() > 64 - frameCount) throw new IOException("Relay stream frame rate exceeded");
          frameCount += batch.size();
          // Validate the full decoded read before any application delivery.
          for (PublishedRelayWebSocketFrames.Event event : batch) {
            if ("error".equals(event.type) || "close".equals(event.type)) throw new IOException("Invalid or closed relay stream");
            if ("text".equals(event.type)) classifier.classify(event.text);
          }
          for (PublishedRelayWebSocketFrames.Event event : batch) {
            abort.check();
            if ("text".equals(event.type)) {
              if (classifier.classify(event.text) == TextKind.EOSE) deadline.persistent();
              control.text(event.text);
            } else if ("ping".equals(event.type)) { output.write(PublishedRelayWebSocketClientFrames.pong(event.bytes)); output.flush(); }
          }
        }
      }
    } catch (IllegalArgumentException invalid) { throw new IOException("Invalid relay stream", invalid); }
    finally { abort.close(); }
  }

  static RelayUrl parseUrl(String raw) throws IOException {
    if (raw == null || raw.length() > MAX_URL_CHARS || raw.indexOf('\\') >= 0) throw invalidUrl();
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c <= 0x20 || c >= 0x7f) throw invalidUrl();
    }
    final URI uri;
    try { uri = new URI(raw); }
    catch (Exception invalid) { throw new IOException("Invalid relay URL", invalid); }
    if (!"wss".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getHost() == null ||
        uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() == 0 ||
        uri.getPort() < -1 || uri.getPort() > 65535 || !validRelayHostname(uri.getHost())) {
      throw invalidUrl();
    }
    String path = uri.getRawPath();
    if (path == null || path.isEmpty()) path = "/";
    if (!path.startsWith("/") || hasLineBreak(path) || hasEncodedControl(path) || hasDotSegment(path)) throw invalidUrl();
    String authorityHost = uri.getHost();
    int port = uri.getPort() < 0 ? 443 : uri.getPort();
    String normalizedHost = authorityHost.toLowerCase(Locale.ROOT);
    String hostHeader = port == 443 ? normalizedHost : normalizedHost + ":" + port;
    String canonical = "wss://" + hostHeader + ("/".equals(path) ? "" : path);
    if (!raw.equals(canonical)) throw invalidUrl();
    return new RelayUrl(normalizedHost, port, path, hostHeader);
  }

  private static boolean validRelayHostname(String host) {
    if (!PublishedHttpsTransport.isDnsHostname(host)) return false;
    String lower = host.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".localdomain")) return false;
    String[] labels = lower.split("\\.", -1);
    return labels.length >= 2 && !labels[labels.length - 1].matches("[0-9]+");
  }
  static InetAddress[] checkedAddresses(InetAddress[] answers, PublishedHttpsTransport.AddressPolicy policy)
      throws IOException {
    return PublishedHttpsTransport.checkedAddresses(answers, policy);
  }
  static InetAddress[] resolve(String hostname, Deadline deadline, AbortMonitor abort,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor executor) throws IOException {
    abort.check();
    FutureTask<InetAddress[]> lookup = new FutureTask<>(() -> resolver.resolve(hostname));
    try { executor.execute(lookup); }
    catch (RejectedExecutionException saturated) { throw new IOException("Relay DNS capacity exhausted", saturated); }
    try {
      while (true) {
        abort.check();
        try { return lookup.get(Math.min(50L, deadline.remainingMs()), TimeUnit.MILLISECONDS); }
        catch (TimeoutException poll) { /* Recheck cancellation and deadline. */ }
      }
    } catch (InterruptedException interrupted) {
      lookup.cancel(true);
      Thread.currentThread().interrupt();
      throw new IOException("Relay DNS lookup interrupted", interrupted);
    } catch (ExecutionException failed) {
      throw new IOException("Relay DNS lookup failed", failed.getCause());
    } finally {
      if (!lookup.isDone()) lookup.cancel(true);
      executor.remove(lookup);
    }
  }

  static SSLSocket connect(RelayUrl relay, InetAddress[] addresses,
      PublishedHttpsTransport.AddressPolicy policy, AbortMonitor abort, Deadline deadline,
      SSLSocketFactory socketFactory, HostnameVerifier hostnameVerifier) throws IOException {
    IOException last = null;
    for (InetAddress address : addresses) {
      abort.check();
      if (!policy.isAllowedAddress(address)) throw new IOException("Disallowed relay address");
      Socket tcp = new Socket();
      abort.setSocket(tcp);
      try {
        tcp.connect(new InetSocketAddress(address, relay.port), deadline.timeoutMs(CONNECT_TIMEOUT_MS));
        SSLSocket tls = (SSLSocket) socketFactory.createSocket(tcp, relay.host, relay.port, true);
        abort.setSocket(tls);
        tls.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS));
        SSLParameters parameters = tls.getSSLParameters();
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        parameters.setServerNames(Collections.singletonList(new SNIHostName(relay.host)));
        tls.setSSLParameters(parameters);
        List<String> protocols = new ArrayList<>();
        for (String protocol : tls.getSupportedProtocols()) {
          if ("TLSv1.2".equals(protocol) || "TLSv1.3".equals(protocol)) protocols.add(protocol);
        }
        if (protocols.isEmpty()) throw new IOException("TLS 1.2 or newer is required");
        tls.setEnabledProtocols(protocols.toArray(new String[0]));
        tls.startHandshake();
        if (!hostnameVerifier.verify(relay.host, tls.getSession())) {
          throw new IOException("Relay TLS hostname mismatch");
        }
        abort.check();
        return tls;
      } catch (IOException failure) {
        last = failure;
        try { tcp.close(); } catch (IOException ignored) {}
      }
    }
    abort.check();
    throw last == null ? new IOException("No vetted relay address connected") : last;
  }

  static SSLSocketFactory defaultFactory() throws IOException {
    try { return SSLContext.getDefault().getSocketFactory(); }
    catch (GeneralSecurityException failure) { throw new IOException("Default TLS unavailable", failure); }
  }

  static void sendHandshake(OutputStream output, RelayUrl relay, byte[] nonce) throws IOException {
    String key = java.util.Base64.getEncoder().encodeToString(nonce);
    String request = "GET " + relay.path + " HTTP/1.1\r\n" +
        "Host: " + relay.hostHeader + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n";
    byte[] bytes = request.getBytes(StandardCharsets.US_ASCII);
    if (bytes.length > MAX_HANDSHAKE_BYTES) throw new IOException("Relay request headers exceeded bound");
    output.write(bytes);
    output.flush();
  }

  static byte[] readHandshake(InputStream input, AbortMonitor abort) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(512);
    int match = 0;
    while (bytes.size() < MAX_HANDSHAKE_BYTES) {
      abort.check();
      int value = input.read();
      if (value < 0) throw new IOException("Relay closed during WebSocket upgrade");
      bytes.write(value);
      if ((byte) value == CRLFCRLF[match]) match++;
      else match = (byte) value == CRLFCRLF[0] ? 1 : 0;
      if (match == CRLFCRLF.length) return bytes.toByteArray();
    }
    throw new IOException("Relay upgrade headers exceeded bound");
  }

  private static List<String> readMessages(DeadlineInput input, OutputStream output, AbortMonitor abort,
      TextStopPolicy shouldStop) throws IOException {
    PublishedRelayWebSocketFrames frames = new PublishedRelayWebSocketFrames();
    byte[] buffer = new byte[PublishedRelayWebSocketFrames.MAX_READ];
    ResponseCollector collector = new ResponseCollector(shouldStop);
    while (!collector.complete()) {
      abort.check();
      int count = input.read(buffer);
      if (count < 0) throw new IOException("Relay closed before EOSE");
      byte[] chunk = new byte[count];
      System.arraycopy(buffer, 0, chunk, 0, count);
      List<PublishedRelayWebSocketFrames.Event> batch = frames.feed(chunk);
      collector.preflight(batch);
      boolean stopAfterRead = false;
      for (PublishedRelayWebSocketFrames.Event event : batch) {
        abort.check();
        if ("text".equals(event.type)) {
          if (collector.complete()) throw new IOException("Relay sent data after validated EOSE");
          stopAfterRead |= collector.accept(event.text);
        } else if ("ping".equals(event.type)) {
          output.write(PublishedRelayWebSocketClientFrames.pong(event.bytes));
          output.flush();
        } else if ("pong".equals(event.type)) {
          // Keep the bounded one-shot query alive; pong payloads are validated by the frame decoder.
        } else if ("close".equals(event.type)) {
          throw new IOException("Relay closed before validated EOSE");
        } else {
          throw new IOException("Invalid relay WebSocket frame: " + event.detail);
        }
      }
      // Process the full decoded read before honoring EOSE, so trailing invalid frames fail closed.
      if (stopAfterRead) return collector.result();
    }
    return collector.result();
  }
  private static boolean hasLineBreak(String value) { return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0; }
  private static boolean hasEncodedControl(String value) {
    for (int i = 0; i + 2 < value.length(); i++) {
      if (value.charAt(i) == '%') {
        int high = Character.digit(value.charAt(i + 1), 16), low = Character.digit(value.charAt(i + 2), 16);
        if (high < 0 || low < 0) return true;
        int decoded = (high << 4) | low;
        if (decoded < 0x20 || decoded == 0x7f) return true;
        i += 2;
      }
    }
    return false;
  }
  private static boolean hasDotSegment(String path) {
    for (String segment : path.split("/", -1)) {
      String normalizedDots = segment.replaceAll("(?i)%2e", ".");
      if (".".equals(normalizedDots) || "..".equals(normalizedDots)) return true;
    }
    return false;
  }
  private static IOException invalidUrl() { return new IOException("Only credential-free public WSS DNS relay URLs are supported"); }
  public enum TextKind { EVENT, OTHER, EOSE }
  /** Classification is made only after the caller structurally validates JSON and subscription id. */
  public interface TextStopPolicy { TextKind classify(String completeText) throws IOException; }

  static final class RelayUrl {
    final String host;
    final int port;
    final String path;
    final String hostHeader;
    RelayUrl(String host, int port, String path, String hostHeader) {
      this.host = host; this.port = port; this.path = path; this.hostHeader = hostHeader;
    }
  }

  static final class Deadline {
    volatile long expiresAt;
    volatile boolean persistent;
    private final LongSupplier nowNanos;
    private Deadline() { nowNanos = System::nanoTime; expiresAt = nowNanos.getAsLong() + TOTAL_TIMEOUT_MS * 1_000_000L; }
    private Deadline(long absoluteElapsedMs, LongSupplier elapsedClock) {
      nowNanos = () -> TimeUnit.MILLISECONDS.toNanos(elapsedClock.getAsLong());
      expiresAt = TimeUnit.MILLISECONDS.toNanos(absoluteElapsedMs);
    }
    static Deadline start() { return new Deadline(); }
    static Deadline atElapsed(long absoluteElapsedMs, LongSupplier elapsedClock) {
      if (absoluteElapsedMs <= 0 || elapsedClock == null) throw new IllegalArgumentException("Invalid relay deadline");
      return new Deadline(absoluteElapsedMs, elapsedClock);
    }
    void persistent() { persistent = true; expiresAt = Long.MAX_VALUE; }
    int remainingMs() throws SocketTimeoutException {
      long remaining = expiresAt - nowNanos.getAsLong();
      if (remaining <= 0) throw new SocketTimeoutException("Relay query timed out");
      return (int) Math.max(1L, Math.min(Integer.MAX_VALUE, (remaining + 999_999L) / 1_000_000L));
    }
    int timeoutMs(int maximum) throws SocketTimeoutException { return Math.min(remainingMs(), maximum); }
    boolean expired() { return nowNanos.getAsLong() >= expiresAt; }
  }

}
