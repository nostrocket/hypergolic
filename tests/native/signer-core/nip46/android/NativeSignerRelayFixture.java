package org.nostrocket.hypergolic.host;

import android.os.SystemClock;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/** Test APK only. Real TLS verifies the relay hostname against the pinned disposable certificate. */
public final class NativeSignerRelayFixture {
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(4), task -> { Thread thread = new Thread(task, "signer-fixture-dns"); thread.setDaemon(true); return thread; });
  private NativeSignerRelayFixture() {}
  public static NativeSignerRelay open(String url, NativeSignerRelay.Control control, long deadline,
      NativeSignerRelay.Budget budget, byte[] certificateDER) throws IOException {
    try {
      if (certificateDER == null || certificateDER.length == 0 || certificateDER.length > 16_384) throw new IOException("Missing bounded fixture certificate");
      ByteArrayInputStream bytes = new ByteArrayInputStream(certificateDER);
      X509Certificate certificate = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(bytes);
      if (bytes.available() != 0) throw new IOException("Trailing fixture certificate bytes");
      certificate.checkValidity();
      KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null, null); store.setCertificateEntry("fixture", certificate);
      TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(store);
      SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, trust.getTrustManagers(), null);
      PublishedHttpsTransport.AddressPolicy loopback = new PublishedHttpsTransport.AddressPolicy() {
        @Override public boolean isAllowedHost(String host) { return "relay.example.org".equals(host); }
        @Override public boolean isAllowedAddress(InetAddress address) { return address.isLoopbackAddress(); }
      };
      NativeSignerRelay.Transport transport = new NativeSignerRelay.Transport(loopback,
          ignored -> new InetAddress[] {InetAddress.getByAddress(new byte[] {127, 0, 0, 1})}, DNS,
          tls.getSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier(), SystemClock::elapsedRealtime);
      return NativeSignerRelay.openWithTransport(url, control, deadline, budget, transport);
    } catch (GeneralSecurityException invalid) { throw new IOException("Invalid fixture TLS certificate", invalid); }
  }
  public static void shutdown() { DNS.shutdownNow(); }
}
