package org.nostrocket.hypergolic.host;
import java.io.IOException;
import java.net.InetAddress;
import java.util.concurrent.ThreadPoolExecutor;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import org.nostrocket.hypergolic.host.PublishedHttpsResponseReader.TransferIdle;

/** Reuses exact vetted DNS/TLS/URL/redirect/cancellation transport; only framing/output differs. */
final class LiveMP3HTTPS {
  private LiveMP3HTTPS() {}
  static void stream(String url, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.Cancellation cancellation, LiveMP3Budget budget, LiveMP3Response.Sink sink) throws IOException {
    streamWithTransport(url, policy, cancellation, budget, sink, InetAddress::getAllByName, PublishedHttpsTransport.DNS,
        PublishedHttpsTransport.defaultSocketFactory(), HttpsURLConnection.getDefaultHostnameVerifier());
  }
  static void streamWithTransport(String url, PublishedHttpsTransport.AddressPolicy policy,
      PublishedHttpsTransport.Cancellation cancellation, LiveMP3Budget budget, LiveMP3Response.Sink sink,
      PublishedHttpsTransport.HostResolver resolver, ThreadPoolExecutor executor, SSLSocketFactory factory,
      HostnameVerifier verifier) throws IOException {
    TransferIdle idle = new TransferIdle(LiveMP3Budget.IDLE_MS);
    PublishedHttpsTransport.Cancellation active = () -> idle.expired() || !budget.active() || cancellation.isCancelled();
    PublishedHttpsTransport.fetchWithTransport(url, policy, active, resolver, executor, factory, verifier,
        PublishedHttpsTransport.ReadProfile.LIVE_MP3, PublishedHttpsTransport.Deadline.afterMillis(budget.remainingMillis()),
        LiveMP3Budget.IDLE_MS, idle, (input, abort) -> { LiveMP3Response.read(input, budget, abort::check, sink); return null; });
  }
}
