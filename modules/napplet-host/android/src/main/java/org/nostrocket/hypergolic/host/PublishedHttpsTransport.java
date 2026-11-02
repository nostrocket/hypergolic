package org.nostrocket.hypergolic.host;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Bounded HTTPS-only retrieval for published napplet artifacts. */
public final class PublishedHttpsTransport {
  public static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
  public static final int MAX_RESPONSE_HEADER_BYTES = 32 * 1024;
  public static final int CONNECT_TIMEOUT_MS = 8_000;
  public static final int READ_TIMEOUT_MS = 12_000;
  public static final int TOTAL_TIMEOUT_MS = 30_000;
  private static final int MAX_RESPONSE_HEADERS = 128;
  private static final int MAX_CHUNK_LINE_BYTES = 128;
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(4), task -> {
        Thread thread = new Thread(task, "napplet-https-dns");
        thread.setDaemon(true);
        return thread;
      });

  private PublishedHttpsTransport() {}

  /** Application-owned SSRF policy. Address checks run after DNS resolution, immediately before connect. */
  public interface AddressPolicy {
    boolean isAllowedHost(String hostname);
    boolean isAllowedAddress(InetAddress address);
  }

  /** The caller connects cancellation to the owning napplet-open operation. */
  public interface Cancellation { boolean isCancelled(); }

  /** Returns verified-by-connection HTTPS bytes only; callers still verify signed event and HTML claims. */
  public static byte[] get(String rawUrl, AddressPolicy policy, Cancellation cancellation) throws IOException {
    return getWithTransport(rawUrl, policy, cancellation, InetAddress::getAllByName, DNS,
        defaultSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier());
  }

  /** Package-local transport inputs let the host-JVM proof use an isolated TLS endpoint. */
  static byte[] getWithTransport(String rawUrl, AddressPolicy policy, Cancellation cancellation,
      HostResolver resolver, ThreadPoolExecutor executor, SSLSocketFactory socketFactory,
      HostnameVerifier hostnameVerifier) throws IOException {
    return getBoundedWithTransport(rawUrl, policy, cancellation, resolver, executor, socketFactory, hostnameVerifier, MAX_BODY_BYTES, TOTAL_TIMEOUT_MS);
  }

  /** Separate app-only resource profile; the published-loader entry point remains bounded at 2 MiB. */
  static byte[] getResource(String rawUrl, AddressPolicy policy, Cancellation cancellation) throws IOException {
    return getBoundedWithTransport(rawUrl, policy, cancellation, InetAddress::getAllByName, DNS,
        defaultSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier(), 10 * 1024 * 1024, 15_000);
  }
  static byte[] getResourceWithTransport(String rawUrl, AddressPolicy policy, Cancellation cancellation,
      HostResolver resolver, ThreadPoolExecutor executor, SSLSocketFactory socketFactory,
      HostnameVerifier hostnameVerifier) throws IOException {
    return getBoundedWithTransport(rawUrl, policy, cancellation, resolver, executor, socketFactory, hostnameVerifier, 10 * 1024 * 1024, 15_000);
  }
  private static byte[] getBoundedWithTransport(String rawUrl, AddressPolicy policy, Cancellation cancellation,
      HostResolver resolver, ThreadPoolExecutor executor, SSLSocketFactory socketFactory,
      HostnameVerifier hostnameVerifier, int maximumBytes, int timeoutMs) throws IOException {
    if (cancellationRequested(cancellation)) throw new IOException("Request cancelled");
    Deadline deadline = Deadline.afterMillis(timeoutMs);
    AbortMonitor abort = new AbortMonitor(cancellation, deadline);
    String current = rawUrl;
    java.util.Set<String> visited = new java.util.HashSet<>();
    try {
      for (int hop = 0; hop <= 2; hop++) {
        abort.check();
        URL url = validateRequest(current, policy);
        if (!visited.add(url.toExternalForm())) throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "Resource redirect loop");
        URI uri;
        try { uri = new URI(current); }
        catch (URISyntaxException error) { throw new IOException("Invalid HTTPS URL", error); }
        SSLSocket socket = openPinnedTls(url.getHost(), url.getPort() < 0 ? 443 : url.getPort(), policy,
            abort, deadline, resolver, executor, socketFactory, hostnameVerifier);
        try (SSLSocket closeable = socket) {
          closeable.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS));
          sendRequest(closeable.getOutputStream(), uri, url);
          byte[] body = PublishedHttpsResponseReader.readBounded(new DeadlineInputStream(closeable.getInputStream(), closeable, deadline), cancellation, maximumBytes);
          abort.check();
          return body;
        } catch (PublishedHttpsResponseReader.ResourceRedirect redirect) {
          if (maximumBytes <= MAX_BODY_BYTES || hop == 2) throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "Resource redirect limit");
          try { current = uri.resolve(redirect.location).toString(); validateRequest(current, policy); }
          catch (IOException | IllegalArgumentException invalid) {
            throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "Invalid resource redirect target");
          }
        }
      }
      throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "Resource redirect limit");
    } finally { abort.close(); }
  }

  static URL parseUrl(String rawUrl) throws IOException {
    if (rawUrl == null || rawUrl.length() > 8192 || rawUrl.indexOf('\\') >= 0) {
      throw new IOException("Invalid HTTPS URL");
    }
    for (int i = 0; i < rawUrl.length(); i++) {
      char c = rawUrl.charAt(i);
      if (c <= 0x20 || c == 0x7f) throw new IOException("Invalid HTTPS URL");
    }
    final URI uri;
    try { uri = new URI(rawUrl); }
    catch (URISyntaxException error) { throw new IOException("Invalid HTTPS URL", error); }
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null ||
        uri.getHost() == null || uri.getPort() == 0 || uri.getPort() < -1 ||
        uri.getPort() > 65535 || uri.getRawFragment() != null) {
      throw new IOException("Only credential-free HTTPS URLs are supported");
    }
    try { return uri.toURL(); }
    catch (IllegalArgumentException error) { throw new IOException("Invalid HTTPS URL", error); }
  }

  static URL validateRequest(String rawUrl, AddressPolicy policy) throws IOException {
    if (policy == null) throw new IllegalArgumentException("Missing address policy");
    URL url = parseUrl(rawUrl);
    String host = url.getHost();
    if (!isDnsHostname(host) || !policy.isAllowedHost(host.toLowerCase(Locale.ROOT))) {
      throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "Unsafe HTTPS host");
    }
    return url;
  }

  static boolean isDnsHostname(String host) {
    if (host == null || host.length() > 253 || host.indexOf(':') >= 0 || !host.contains(".")) return false;
    String lower = host.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".") || lower.equals("localhost") || lower.endsWith(".localhost") ||
        lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".test") ||
        lower.equals("example") || lower.endsWith(".example") || lower.equals("invalid") ||
        lower.endsWith(".invalid") || lower.endsWith(".lan") || lower.endsWith(".home") ||
        lower.endsWith(".home.arpa") || lower.endsWith(".onion") || lower.endsWith(".arpa")) return false;
    if (lower.matches("[0-9.]+") || looksLikeNonDecimalIpv4(lower)) return false;
    String[] labels = lower.split("\\.", -1);
    for (String label : labels) {
      if (label.isEmpty() || label.length() > 63 || label.startsWith("-") || label.endsWith("-") ||
          !label.matches("[a-z0-9-]+")) return false;
    }
    return true;
  }

  private static boolean looksLikeNonDecimalIpv4(String host) {
    String[] parts = host.split("\\.", -1);
    if (parts.length > 4) return false;
    boolean numeric = true;
    for (String part : parts) {
      if (part.isEmpty()) return false;
      boolean decimal = true;
      for (int i = 0; i < part.length(); i++) if (!Character.isDigit(part.charAt(i))) decimal = false;
      if (!decimal) numeric = false;
      if (part.length() > 2 && part.startsWith("0x")) {
        for (int i = 2; i < part.length(); i++) if (Character.digit(part.charAt(i), 16) < 0) return false;
        return true;
      }
    }
    return numeric && parts.length < 4;
  }

  static InetAddress[] checkedAddresses(InetAddress[] resolved, AddressPolicy policy) throws IOException {
    if (resolved == null || resolved.length == 0 || policy == null) throw new IOException("DNS returned no addresses");
    for (InetAddress address : resolved) {
      if (address == null || !policy.isAllowedAddress(address)) {
        throw new PublishedHttpsResponseReader.ResourceFailure("blocked-by-policy", "DNS resolved to a disallowed address");
      }
    }
    return resolved.clone();
  }

  static SSLSocket openPinnedTls(String host, int port, AddressPolicy policy, AbortMonitor abort,
      Deadline deadline, HostResolver resolver, ThreadPoolExecutor executor, SSLSocketFactory socketFactory,
      HostnameVerifier hostnameVerifier)
      throws IOException {
    abort.check();
    InetAddress[] addresses = checkedAddresses(resolveAddresses(host,
        abort::isCancelled, deadline, resolver, executor), policy);
    abort.check();
    IOException lastFailure = null;
    for (InetAddress address : addresses) {
      if (abort != null) abort.check();
      Socket tcp = new Socket();
      if (abort != null) abort.setSocket(tcp);
      try {
        tcp.connect(new InetSocketAddress(address, port), deadline.timeoutMs(CONNECT_TIMEOUT_MS));
        SSLSocket tls = (SSLSocket) socketFactory.createSocket(tcp, host, port, true);
        if (abort != null) abort.setSocket(tls);
        tls.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS));
        SSLParameters parameters = tls.getSSLParameters();
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        parameters.setServerNames(Collections.singletonList(new SNIHostName(host)));
        tls.setSSLParameters(parameters);
        List<String> secureProtocols = new ArrayList<>();
        for (String protocol : tls.getSupportedProtocols()) {
          if ("TLSv1.2".equals(protocol) || "TLSv1.3".equals(protocol)) secureProtocols.add(protocol);
        }
        if (secureProtocols.isEmpty()) throw new IOException("TLS 1.2 or newer is required");
        tls.setEnabledProtocols(secureProtocols.toArray(new String[0]));
        tls.startHandshake();
        if (!hostnameVerifier.verify(host, tls.getSession())) {
          tls.close();
          throw new IOException("HTTPS certificate hostname mismatch");
        }
        return tls;
      } catch (IOException failure) {
        lastFailure = failure;
        try { tcp.close(); } catch (IOException ignored) {}
      }
    }
    if (abort != null) abort.check();
    throw lastFailure == null ? new IOException("No vetted HTTPS address connected") : lastFailure;
  }

  static InetAddress[] resolveAddresses(String host, Cancellation cancellation, Deadline deadline,
      HostResolver resolver, ThreadPoolExecutor executor) throws IOException {
    checkDeadlineAndCancellation(deadline, cancellation);
    FutureTask<InetAddress[]> lookup = new FutureTask<>(() -> resolver.resolve(host));
    try { executor.execute(lookup); }
    catch (RejectedExecutionException saturated) { throw new IOException("HTTPS DNS capacity exhausted", saturated); }
    try {
      while (true) {
        checkDeadlineAndCancellation(deadline, cancellation);
        long remainingMs = deadline.remainingMs();
        if (remainingMs <= 0) throw new SocketTimeoutException("Published napplet HTTPS request timed out");
        try { return lookup.get(Math.min(50L, remainingMs), TimeUnit.MILLISECONDS); }
        catch (TimeoutException poll) { /* Recheck cancellation and deadline. */ }
      }
    } catch (InterruptedException interrupted) {
      lookup.cancel(true);
      Thread.currentThread().interrupt();
      throw new IOException("HTTPS DNS lookup interrupted", interrupted);
    } catch (ExecutionException failed) {
      Throwable cause = failed.getCause();
      if (cause instanceof IOException) throw (IOException) cause;
      throw new IOException("HTTPS DNS lookup failed", cause);
    } finally {
      if (!lookup.isDone()) lookup.cancel(true);
      executor.remove(lookup);
    }
  }

  private static void checkDeadlineAndCancellation(Deadline deadline, Cancellation cancellation) throws IOException {
    if (deadline.expired()) throw new SocketTimeoutException("Published napplet HTTPS request timed out");
    checkCancellation(cancellation);
  }

  interface HostResolver { InetAddress[] resolve(String hostname) throws IOException; }

  static SSLSocketFactory defaultSocketFactory() throws IOException {
    try { return SSLContext.getDefault().getSocketFactory(); }
    catch (GeneralSecurityException error) { throw new IOException("Default TLS is unavailable", error); }
  }

  private static void sendRequest(OutputStream output, URI uri, URL url) throws IOException {
    String target = requestTarget(uri);
    String host = url.getHost();
    int port = url.getPort();
    String hostHeader = port < 0 || port == 443 ? host : host + ":" + port;
    String request = "GET " + target + " HTTP/1.1\r\n" +
        "Host: " + hostHeader + "\r\n" +
        "Accept-Encoding: identity\r\n" +
        "Connection: close\r\n" +
        "\r\n";
    output.write(request.getBytes(StandardCharsets.US_ASCII));
    output.flush();
  }

  static String requestTarget(URI uri) throws IOException {
    String ascii = uri.toASCIIString();
    int schemeEnd = ascii.indexOf("://");
    if (schemeEnd < 0) throw new IOException("Invalid HTTPS URL");
    int start = ascii.indexOf('/', schemeEnd + 3);
    int query = ascii.indexOf('?', schemeEnd + 3);
    if (start < 0 || (query >= 0 && query < start)) start = query;
    if (start < 0) return "/";
    String target = ascii.substring(start);
    if (target.charAt(0) == '?') target = "/" + target;
    if (target.indexOf('\r') >= 0 || target.indexOf('\n') >= 0 || target.indexOf(' ') >= 0) {
      throw new IOException("Invalid HTTPS request target");
    }
    for (int i = 0; i + 2 < target.length(); i++) {
      if (target.charAt(i) == '%') {
        int hi = Character.digit(target.charAt(i + 1), 16);
        int lo = Character.digit(target.charAt(i + 2), 16);
        if (hi < 0 || lo < 0) throw new IOException("Invalid HTTPS request target escape");
        int decoded = (hi << 4) | lo;
        if (decoded < 0x20 || decoded == 0x7f) throw new IOException("Encoded control in HTTPS request target");
        i += 2;
      }
    }
    return target;
  }

  static byte[] readResponse(InputStream input, Cancellation cancellation) throws IOException {
    return PublishedHttpsResponseReader.read(input, cancellation);
  }

  private static boolean cancellationRequested(Cancellation cancellation) throws IOException {
    if (cancellation == null) return false;
    try { return cancellation.isCancelled(); }
    catch (RuntimeException failure) { throw new IOException("Cancellation state unavailable", failure); }
  }
  static void checkCancellation(Cancellation cancellation) throws IOException {
    if (cancellationRequested(cancellation)) throw new IOException("Request cancelled");
  }

  static final class Deadline {
    private final long deadlineNanos;
    private Deadline(long deadlineNanos) { this.deadlineNanos = deadlineNanos; }
    static Deadline afterMillis(long durationMs) { return new Deadline(System.nanoTime() + durationMs * 1_000_000L); }
    boolean expired() { return System.nanoTime() >= deadlineNanos; }
    long remainingMs() {
      long remaining = deadlineNanos - System.nanoTime();
      return remaining <= 0 ? 0 : (remaining + 999_999L) / 1_000_000L;
    }
    int timeoutMs(int maximumMs) throws SocketTimeoutException {
      long remaining = deadlineNanos - System.nanoTime();
      if (remaining <= 0) throw new SocketTimeoutException("Published napplet HTTPS request timed out");
      long rounded = (remaining + 999_999L) / 1_000_000L;
      return (int) Math.max(1L, Math.min((long) maximumMs, rounded));
    }
  }

  static final class DeadlineInputStream extends FilterInputStream {
    private final Socket socket;
    private final Deadline deadline;
    DeadlineInputStream(InputStream input, Socket socket, Deadline deadline) {
      super(input);
      this.socket = socket;
      this.deadline = deadline;
    }
    private void updateTimeout() throws IOException { socket.setSoTimeout(deadline.timeoutMs(READ_TIMEOUT_MS)); }
    @Override public int read() throws IOException { updateTimeout(); return super.read(); }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
      updateTimeout();
      return super.read(bytes, offset, length);
    }
  }

  private static final class HeaderBlock {
    final String text;
    final int size;
    HeaderBlock(String text, int size) { this.text = text; this.size = size; }
  }

  static final class AbortMonitor implements AutoCloseable {
    private volatile boolean stopped;
    private volatile Socket socket;
    private final Cancellation cancellation;
    private final Deadline deadline;
    private final Thread thread;
    AbortMonitor(Cancellation cancellation, Deadline deadline) {
      this.cancellation = cancellation;
      this.deadline = deadline;
      thread = new Thread(() -> {
        while (!stopped) {
          try {
            if ((cancellation != null && cancellation.isCancelled()) || deadline.expired()) {
              closeSocket();
              return;
            }
            Thread.sleep(50L);
          } catch (InterruptedException ignored) { return; }
          catch (RuntimeException failure) { closeSocket(); return; }
        }
      }, "napplet-https-cancel");
      thread.setDaemon(true);
      thread.start();
    }
    void setSocket(Socket value) throws IOException {
      socket = value;
      check();
    }
    void check() throws IOException {
      if (deadline.expired()) {
        closeSocket();
        throw new SocketTimeoutException("Published napplet HTTPS request timed out");
      }
      if (cancellationRequested(cancellation)) { closeSocket(); throw new IOException("Request cancelled"); }
    }
    boolean isCancelled() {
      try { return cancellationRequested(cancellation); }
      catch (IOException unavailable) { return true; }
    }
    private void closeSocket() {
      Socket current = socket;
      if (current != null) try { current.close(); } catch (IOException ignored) {}
    }
    @Override public void close() {
      stopped = true;
      thread.interrupt();
      closeSocket();
      try { thread.join(100L); }
      catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
  }
}
