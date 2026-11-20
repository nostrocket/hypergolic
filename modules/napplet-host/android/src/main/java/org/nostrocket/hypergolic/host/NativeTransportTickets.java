package org.nostrocket.hypergolic.host;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Only IDs recently issued by the trusted shell and not yet started can open a transport. */
final class NativeTransportTickets {
  private static final String[] issued = new String[4096];
  private static final Set<String> available = new HashSet<>();
  private static int next;

  private NativeTransportTickets() {}

  static synchronized String issue() {
    String id = UUID.randomUUID().toString();
    available.remove(issued[next]);
    issued[next] = id;
    next = (next + 1) % issued.length;
    available.add(id);
    return id;
  }

  /** Claim and cancel-before-start both consume the reservation. Eviction never permits replay. */
  static synchronized boolean consume(String id) { return available.remove(id); }

  static synchronized void revokeAll() { available.clear(); }
}
