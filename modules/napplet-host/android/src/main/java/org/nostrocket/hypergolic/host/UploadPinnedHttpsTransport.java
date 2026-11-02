package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Private exact-body PUT owner. A native grant is mandatory; no arbitrary guest fetch/header API exists. */
final class UploadPinnedHttpsTransport {
  interface Progress { void sent(int bytes); }
  static final class Failure extends IOException {
    private static final long serialVersionUID = 1L;
    final String code;
    final boolean dispatched;
    Failure(String code, boolean dispatched) { super(code); this.code = code; this.dispatched = dispatched; }
  }
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(2), task -> { Thread thread = new Thread(task, "upload-https-dns"); thread.setDaemon(true); return thread; });
  private UploadPinnedHttpsTransport() {}
  static PublishedHttpsResponseReader.UploadResponse put(NativeUploadAuthority authority, NativeUploadAuthority.Grant grant,
      NativeBlossomPermit permit, Progress progress) throws IOException {
    return putWithTransport(authority, grant, permit, progress, PublishedHttpsRequestOwner.addressPolicy(),
      InetAddress::getAllByName, DNS, PublishedHttpsTransport.defaultSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier(),
      () -> System.currentTimeMillis()/1000);
  }
  /** Package-local owning TLS proof seam; production always uses public-address and platform trust policy. */
  static PublishedHttpsResponseReader.UploadResponse putWithTransport(NativeUploadAuthority authority, NativeUploadAuthority.Grant grant,
      NativeBlossomPermit permit, Progress progress, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor dns, SSLSocketFactory factory,
      HostnameVerifier verifier, LongSupplier now) throws IOException {
    if (authority == null || permit == null || authority.approvedReview(grant) != permit.review ||
      !permit.validAt(now.getAsLong()) || !authority.claimTransfer(grant)) throw new Failure("policy denied", false);
    PublishedHttpsTransport.Cancellation cancellation = () -> !authority.isApproved(grant) || !permit.validAt(now.getAsLong());
    var deadline = PublishedHttpsTransport.Deadline.afterMillis(60_000);
    byte[] body = null;
    try (var abort = new PublishedHttpsTransport.AbortMonitor(cancellation, deadline)) {
      abort.check(); URL url = PublishedHttpsTransport.validateRequest(permit.review.destination + "/upload", policy);
      try (SSLSocket socket = PublishedHttpsTransport.openPinnedTls(url.getHost(), url.getPort() < 0 ? 443 : url.getPort(),
          policy, abort, deadline, resolver, dns, factory, verifier)) {
        abort.check(); body = authority.dispatch(grant); if (body == null) throw new Failure("policy denied", false);
        String host = url.getHost() + (url.getPort() < 0 || url.getPort() == 443 ? "" : ":" + url.getPort());
        String headers = "PUT /upload HTTP/1.1\r\nHost: " + host + "\r\nContent-Type: " + permit.review.mimeType +
          "\r\nContent-Length: " + body.length + "\r\nX-SHA-256: " + permit.review.sha256 +
          "\r\nAuthorization: " + permit.authorization + "\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream(); abort.check(); output.write(headers.getBytes(StandardCharsets.US_ASCII));
        for (int offset = 0; offset < body.length;) {
          abort.check(); int length = Math.min(8192, body.length - offset); output.write(body, offset, length); offset += length;
          if (progress != null) try { progress.sent(offset); } catch (RuntimeException ignored) { /* Presentation has no transfer authority. */ }
        }
        abort.check(); output.flush();
        var response = PublishedHttpsResponseReader.readUpload(new PublishedHttpsTransport.DeadlineInputStream(socket.getInputStream(), socket, deadline), cancellation);
        abort.check(); return response;
      }
    } catch (PublishedHttpsResponseReader.UploadStatus rejected) {
      String code = rejected.status == 413 ? "file too large" : rejected.status == 429 ? "quota exceeded" :
        rejected.status >= 400 && rejected.status < 500 ? "server rejected" : "outcome unknown";
      throw new Failure(code, authority.wasDispatched(grant));
    } catch (IOException | RuntimeException failed) {
      boolean dispatched = authority.wasDispatched(grant);
      String code = dispatched ? "outcome unknown" : !authority.isApproved(grant) ? "user cancelled" :
        failed instanceof PublishedHttpsResponseReader.ResourceFailure ? "policy denied" : "upload failed";
      throw new Failure(code, dispatched);
    } finally { if (body != null) Arrays.fill(body, (byte) 0); }
  }
}
