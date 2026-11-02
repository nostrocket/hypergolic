package org.nostrocket.hypergolic.host;

import android.os.Build;
import android.os.Process;
import javax.net.ssl.SSLContext;

/** Selected native transport cases on physical Android, separate from Expo and app lifecycle. */
public final class PhysicalTransportProof {
  private PhysicalTransportProof() { }
  public static void main(String[] args) throws Exception {
    if (args.length != 4) throw new IllegalArgumentException("Expected two disposable TLS identities");
    if (Process.myUid() != 2000) throw new IllegalStateException("Expected isolated shell process");
    System.out.println("{\"sdk\":" + Build.VERSION.SDK_INT + ",\"uid\":" + Process.myUid() +
        ",\"pid\":" + Process.myPid() + ",\"tlsProvider\":\"" +
        SSLContext.getDefault().getProvider().getName() + "\"}");
    PublishedHttpsTlsProof.main(new String[] {args[0], args[1]});
    PublishedRelayWssTlsProof.main(new String[] {args[2], args[3]});
    PublishedRelayResponseClassifierProof.main(new String[0]);
  }
}
