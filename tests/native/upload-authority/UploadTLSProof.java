package org.nostrocket.hypergolic.host;

import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** Real TLS upload over an explicitly injected owning-proof endpoint; no guest or UI claim. */
public final class UploadTLSProof {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(args[0]); String mode = args[3];
    var authority = new NativeUploadAuthority(() -> System.nanoTime()/1_000_000);
    var session = authority.register("fixture", "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    var other = authority.register("other", "a".repeat(64)); authority.setForeground(true); authority.focus(session);
    var request = authority.admit(session, 3, "https://files.example.com:" + port, "application/octet-stream");
    if (!authority.append(request, 0, new byte[]{1,2,3})) throw new AssertionError("Stage failed");
    var review = authority.seal(request); var permit = NativeBlossomPermit.capture(review, args[2], 1001);
    if (permit == null) throw new AssertionError("Permit failed");
    var grant = authority.approve(request, review); if (authority.claimSigning(grant) != review) throw new AssertionError("Sign claim failed");
    if (mode.equals("cancel-before")) { authority.setForeground(false); authority.setForeground(true); }
    InetAddress loopback = InetAddress.getByAddress(new byte[]{127,0,0,1});
    var policy = new PublishedHttpsTransport.AddressPolicy() {
      @Override public boolean isAllowedHost(String host) { return host.equals("files.example.com"); }
      @Override public boolean isAllowedAddress(InetAddress address) { return address.equals(loopback); }
    };
    SSLSocketFactory factory = mode.equals("untrusted") ? SSLContext.getDefault().getSocketFactory() : trusted(Path.of(args[1]));
    HostnameVerifier verify = (host, connection) -> {
      try {
        var cert = (X509Certificate) connection.getPeerCertificates()[0];
        for (List<?> name : cert.getSubjectAlternativeNames()) if (name.size() >= 2 && Integer.valueOf(2).equals(name.get(0)) && host.equals(name.get(1))) return true;
      } catch (Exception ignored) { return false; }
      return false;
    };
    ThreadPoolExecutor dns = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(2));
    try {
      var response = UploadPinnedHttpsTransport.putWithTransport(authority, grant, permit, bytes -> {
        if (mode.equals("switch")) authority.focus(other);
        if (mode.equals("cancel-after")) { authority.setForeground(false); authority.setForeground(true); }
      }, policy, host -> mode.equals("mixed-dns") ? new InetAddress[]{loopback, InetAddress.getByAddress(new byte[]{10,0,0,1})} : new InetAddress[]{loopback},
        dns, factory, verify, () -> 1001);
      System.out.println("{\"language\":\"Java\",\"status\":"+response.status+",\"dispatched\":"+authority.wasDispatched(grant)+",\"receiptBytes\":"+response.body.length+"}");
    } catch (UploadPinnedHttpsTransport.Failure failure) {
      System.out.println("{\"language\":\"Java\",\"error\":\""+failure.code+"\",\"dispatched\":"+failure.dispatched+"}");
    } finally { dns.shutdownNow(); authority.revokeAll(); }
  }
  private static SSLSocketFactory trusted(Path pem) throws Exception {
    var certificate = CertificateFactory.getInstance("X.509").generateCertificate(Files.newInputStream(pem));
    KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null, null); store.setCertificateEntry("disposable-proof", certificate);
    TrustManagerFactory managers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); managers.init(store);
    SSLContext context = SSLContext.getInstance("TLS"); context.init(null, managers.getTrustManagers(), null); return context.getSocketFactory();
  }
}
