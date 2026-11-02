package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.Socket;

/** Explicit host relay-control interface port; no relay, DNS, TLS or socket write. */
public final class NativeSignerRelay {
  private NativeSignerRelay() {}
  public interface Control {
    boolean isCancelled();
    void attach(Socket raw) throws IOException;
    void beforeSend() throws IOException;
  }
}
