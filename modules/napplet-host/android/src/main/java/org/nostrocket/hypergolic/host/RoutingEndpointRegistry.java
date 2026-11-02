package org.nostrocket.hypergolic.host;

import java.util.HashMap;
import java.util.Map;

/** Native source/recipient authority. App callbacks cannot revive a revoked identity or background epoch. */
public final class RoutingEndpointRegistry {
  private static final long MAX = 9_007_199_254_740_991L;
  private static final class Endpoint {
    final String user; final long epoch; final boolean intent; final boolean inc; final boolean notify; final boolean config;
    boolean ready; boolean focused; long reviewRevision;
    Endpoint(String user, long epoch, boolean intent, boolean inc, boolean notify, boolean config) { this.user = user; this.epoch = epoch; this.intent = intent; this.inc = inc; this.notify = notify; this.config = config; }
  }
  private final Map<String, Endpoint> endpoints = new HashMap<>();
  private String user = "";
  private long epoch = -1;
  private long revision = 0;
  private boolean available = false;
  private boolean foreground = true;
  public synchronized boolean synchronizeOwner(String nextUser, long nextEpoch, boolean nextAvailable) {
    if (!hex(nextUser) || nextEpoch < 0 || nextEpoch > MAX || nextEpoch < epoch || (nextEpoch == epoch && !user.equals(nextUser)) || revision == MAX) return false;
    if (!user.equals(nextUser) || epoch != nextEpoch || available != nextAvailable) revision++;
    user = nextUser; epoch = nextEpoch; available = nextAvailable; return true;
  }
  public synchronized void foreground(boolean next) {
    if (next != foreground) { if (revision < MAX) revision++; else available = false; }
    foreground = next;
  }
  public synchronized boolean register(String generation, String ownerUser, long ownerEpoch, boolean intent, boolean inc) { return register(generation, ownerUser, ownerEpoch, intent, inc, false); }
  public synchronized boolean register(String generation, String ownerUser, long ownerEpoch, boolean intent, boolean inc, boolean notify) { return register(generation, ownerUser, ownerEpoch, intent, inc, notify, false); }
  public synchronized boolean register(String generation, String ownerUser, long ownerEpoch, boolean intent, boolean inc, boolean notify, boolean config) {
    if (revision == MAX || generation == null || !generation.matches("[A-Za-z0-9_-]{1,80}") || !available || !user.equals(ownerUser) || ownerEpoch != epoch || !(intent || inc || notify || config) || endpoints.containsKey(generation) || endpoints.size() >= 64) return false;
    endpoints.put(generation, new Endpoint(ownerUser, ownerEpoch, intent, inc, notify, config)); return true;
  }
  public synchronized void ready(String generation) { Endpoint endpoint = endpoints.get(generation); if (endpoint != null) endpoint.ready = true; }
  public synchronized boolean focus(String generation, boolean value) {
    Endpoint endpoint = endpoints.get(generation); if (endpoint == null || endpoint.focused == value) return false;
    if (endpoint.reviewRevision < MAX) endpoint.reviewRevision++; endpoint.focused = value; return true;
  }
  public synchronized void revoke(String generation) { endpoints.remove(generation); }
  private boolean active(String generation) {
    Endpoint endpoint = endpoints.get(generation);
    return revision < MAX && foreground && available && endpoint != null && endpoint.ready && endpoint.epoch == epoch && endpoint.user.equals(user);
  }
  public synchronized boolean mayDeliver(String generation, String domain) {
    Endpoint endpoint = endpoints.get(generation);
    return active(generation) && (("intent".equals(domain) && endpoint.intent) || ("inc".equals(domain) && endpoint.inc) || ("notify".equals(domain) && endpoint.notify) || ("config".equals(domain) && endpoint.config));
  }
  public synchronized boolean mayReview(String generation) { return active(generation) && endpoints.get(generation).focused && endpoints.get(generation).reviewRevision < MAX; }
  public synchronized long reviewRevision(String generation) { return mayReview(generation) ? endpoints.get(generation).reviewRevision : -1; }
  public synchronized boolean matchesRevision(long candidate) { return candidate == revision && foreground && available && revision < MAX; }
  public synchronized long revision() { return revision; }
  public synchronized String user() { return user; }
  public synchronized long epoch() { return epoch; }
  public synchronized boolean ownerAvailable() { return available; }
  public synchronized boolean foreground() { return foreground; }
  public synchronized boolean available() { return foreground && available && revision < MAX; }
  private static boolean hex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
}
