package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

/** Fixed provider/hash GET only. Bounded public fixed-hash redirects; no guest URL, credentials, PUT or fallback. */
final class UploadRecoveryHttps {
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(2), task -> { Thread thread = new Thread(task, "upload-recovery-dns"); thread.setDaemon(true); return thread; });
  private UploadRecoveryHttps() {}
  static PublishedHttpsResponseReader.UploadResponse get(UploadRecoveryReadAuthority authority, UploadRecoveryReadAuthority.Lease lease) throws IOException {
    return getWithTransport(authority, lease, PublishedHttpsRequestOwner.addressPolicy(), InetAddress::getAllByName, DNS,
      PublishedHttpsTransport.defaultSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier());
  }
  static PublishedHttpsResponseReader.UploadResponse getWithTransport(UploadRecoveryReadAuthority authority, UploadRecoveryReadAuthority.Lease lease,
    PublishedHttpsTransport.AddressPolicy policy, PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor dns,
    SSLSocketFactory factory, HostnameVerifier verifier) throws IOException {
    if (authority == null || lease == null || !authority.live(lease)) throw new IOException("Recovery revoked");
    PublishedHttpsTransport.Cancellation cancellation = () -> !authority.live(lease);
    var deadline = PublishedHttpsTransport.Deadline.afterMillis(60_000);
    try (var abort = new PublishedHttpsTransport.AbortMonitor(cancellation, deadline)) {
      URL original = validateTarget(lease.record.destination() + "/" + lease.record.sha256(), lease.record.sha256(), policy);
      URL url = original;
      var visited = new java.util.HashSet<String>(); visited.add(url.toExternalForm());
      for (int redirects = 0; ; redirects++) {
        abort.check();
        try (var socket = PublishedHttpsTransport.openPinnedTls(url.getHost(), url.getPort() < 0 ? 443 : url.getPort(), policy, abort, deadline, resolver, dns, factory, verifier)) {
          abort.check(); String host = url.getHost() + (url.getPort() < 0 || url.getPort() == 443 ? "" : ":" + url.getPort());
          String request = "GET " + url.getPath() + " HTTP/1.1\r\nHost: " + host + "\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n";
          socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
          var response = PublishedHttpsResponseReader.readRecovery(new PublishedHttpsTransport.DeadlineInputStream(socket.getInputStream(), socket, deadline), cancellation, NativeUploadAuthority.MAX_BYTES);
          abort.check();
          if (response.status == 404 && (!url.getHost().equalsIgnoreCase(original.getHost()) || url.getPort() != original.getPort())) throw new IOException("Alternate provider absence unresolved");
          return response;
        } catch (PublishedHttpsResponseReader.RecoveryRedirect redirect) {
          abort.check();
          if (redirects >= 2) throw new IOException("Recovery redirect limit");
          URL next = validateTarget(new URL(url, redirect.location).toExternalForm(), lease.record.sha256(), policy);
          if (!visited.add(next.toExternalForm())) throw new IOException("Recovery redirect loop");
          url = next;
        }
      }
    }
  }
  static URL validateTarget(String input, String hash, PublishedHttpsTransport.AddressPolicy policy) throws IOException {
    URL url = PublishedHttpsTransport.validateRequest(input, policy);
    if (!hash.matches("[0-9a-f]{64}") || url.getQuery() != null || url.getRef() != null ||
      !url.getPath().matches("/" + hash + "(\\.[A-Za-z0-9]{1,16})?")) throw new IOException("Recovery hash target changed");
    return url;
  }
}
