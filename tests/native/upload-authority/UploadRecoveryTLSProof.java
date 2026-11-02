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
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

public final class UploadRecoveryTLSProof {
  private static final class Memory implements UploadRecoveryLedger.Store {
    private byte[] value;
    public byte[] read() { return value == null ? null : value.clone(); }
    public void write(byte[] bytes) { value = bytes.clone(); }
  }
  public static void main(String[] args) throws Exception {
    String mode = args[2], identity = "a".repeat(64);
    var record = new UploadRecoveryLedger.Entry("00000000-0000-0000-0000-000000000001", identity, "b".repeat(64), "app", "https://files.example.com:" + args[0],
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", "text/plain", 3, UploadRecoveryLedger.State.UNKNOWN);
    var ledger = new UploadRecoveryLedger(new Memory()); if (!ledger.start(record)) throw new AssertionError("Record start failed");
    var authority = new UploadRecoveryReadAuthority(() -> System.nanoTime()/1_000_000); authority.register("realm", identity); authority.foreground(true); var lease = authority.capture(record);
    if (mode.equals("cancel-before")) { authority.foreground(false); authority.foreground(true); }
    if ((mode.equals("cancel-read") || mode.equals("redirect-cancel"))) new Thread(() -> { try { long deadline = System.nanoTime() + 5_000_000_000L; while (!Files.exists(Path.of(args[3])) && System.nanoTime() < deadline) Thread.sleep(5); } catch (InterruptedException ignored) {Thread.currentThread().interrupt();} authority.foreground(false); authority.foreground(true); }).start();
    var address = InetAddress.getByAddress(new byte[]{127,0,0,1});
    var policy = new PublishedHttpsTransport.AddressPolicy() {
      public boolean isAllowedHost(String host) { return host.equals("files.example.com") || host.equals("other.example.com"); }
      public boolean isAllowedAddress(InetAddress value) { return value.equals(address); }
    };
    var certificate = CertificateFactory.getInstance("X.509").generateCertificate(Files.newInputStream(Path.of(args[1])));
    var store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null, null); store.setCertificateEntry("proof", certificate);
    var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(store);
    var tls = SSLContext.getInstance("TLS"); tls.init(null, trust.getTrustManagers(), null);
    var dns = new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(2));
    var state = UploadRecoveryLedger.State.UNKNOWN;
    try {
      var response = UploadRecoveryHttps.getWithTransport(authority, lease, policy,
        host -> (mode.equals("mixed-dns") || mode.equals("redirect-mixed-dns") && host.equals("other.example.com")) ? new InetAddress[]{address, InetAddress.getByAddress(new byte[]{10,0,0,1})} : new InetAddress[]{address}, dns,
        mode.equals("untrusted") ? SSLContext.getDefault().getSocketFactory() : tls.getSocketFactory(), (host, session) -> {
          try { for (List<?> name : ((X509Certificate)session.getPeerCertificates()[0]).getSubjectAlternativeNames())
            if (name.size() >= 2 && Integer.valueOf(2).equals(name.get(0)) && host.equals(name.get(1))) return true;
          } catch (Exception ignored) { return false; } return false;
        });
      state = authority.finish(lease, response.status, response.body, ledger);
    } catch (java.io.IOException ignored) { /* The uncertainty record must remain intact. */ }
    finally { authority.cancel(lease); dns.shutdownNow(); }
    System.out.println("{\"language\":\"Java\",\"state\":\"" + state.name().toLowerCase(java.util.Locale.ROOT) + "\",\"blocked\":" + ledger.blocks(identity, record.destination(), record.sha256()) + "}");
  }
}
