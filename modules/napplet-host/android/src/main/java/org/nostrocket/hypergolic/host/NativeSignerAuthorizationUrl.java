package org.nostrocket.hypergolic.host;

import android.os.SystemClock;
import java.io.IOException;
import java.net.InetAddress;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Initial browser destination check only. The external browser owns its later DNS, TLS and redirects. */
public final class NativeSignerAuthorizationUrl {
  private static final ThreadPoolExecutor DNS = new ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(2), task -> {
      Thread thread=new Thread(task,"native-signer-auth-dns"); thread.setDaemon(true); return thread;
    });
  private NativeSignerAuthorizationUrl() {}
  public static String validate(String raw, PublishedHttpsTransport.Cancellation cancellation, long deadline) throws IOException {
    var policy=PublishedHttpsRequestOwner.addressPolicy();
    URL url=PublishedHttpsTransport.validateRequest(raw,policy);
    try { PublishedHttpsTransport.requestTarget(url.toURI()); }
    catch(java.net.URISyntaxException invalid) { throw new IOException("Invalid native signer authorization URL"); }
    long remaining=deadline-SystemClock.elapsedRealtime();
    if(remaining<=0) throw new IOException("Native signer operation expired");
    PublishedHttpsTransport.checkedAddresses(PublishedHttpsTransport.resolveAddresses(url.getHost(),cancellation,
      PublishedHttpsTransport.Deadline.afterMillis(Math.min(remaining,8000L)),InetAddress::getAllByName,DNS),policy);
    if(cancellation.isCancelled() || SystemClock.elapsedRealtime()>=deadline) throw new IOException("Native signer operation closed");
    return "https://"+url.getHost().toLowerCase(Locale.ROOT)+(url.getPort()<0 || url.getPort()==443 ? "" : ":"+url.getPort());
  }
}
