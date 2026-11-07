package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.net.InetAddress;

/** A cancelled Future is not proof that an already entered platform resolver has unwound. */
final class NativeResolverOwnership implements PublishedHttpsTransport.HostResolver {
  private final PublishedHttpsTransport.HostResolver resolver;
  private final Runnable drained;
  private boolean entered, abandoned, finished, notified;
  NativeResolverOwnership(PublishedHttpsTransport.HostResolver resolver, Runnable reserved, Runnable drained) {
    this.resolver = resolver; this.drained = drained; reserved.run();
  }
  @Override public InetAddress[] resolve(String hostname) throws IOException {
    synchronized (this) {
      if (abandoned || entered) throw new IOException("Native resolver retired");
      entered = true;
    }
    try { return resolver.resolve(hostname); }
    finally { boolean notify; synchronized (this) { finished = true; notify = notifyOnce(); } if (notify) drained.run(); }
  }
  void ownerLeft() {
    boolean notify;
    synchronized (this) { if (!entered) abandoned = true; notify = notifyOnce(); }
    if (notify) drained.run();
  }
  private boolean notifyOnce() {
    if (notified || !finished && !abandoned) return false;
    notified = true; return true;
  }
}
