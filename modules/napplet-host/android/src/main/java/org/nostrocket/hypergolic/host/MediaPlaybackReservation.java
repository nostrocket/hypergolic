package org.nostrocket.hypergolic.host;

/** A process-wide slot. Cancellation does not free it until every owner resource has unwound. */
final class MediaPlaybackReservation {
  private static Object owner;
  private static boolean draining, uncertain;
  private MediaPlaybackReservation() {}
  static synchronized boolean acquire(Object value) {
    if (owner != null && owner != value) return false;
    if (owner == null) { owner = value; draining = false; uncertain = false; }
    return true;
  }
  static synchronized void release(Object value) { if (owner == value) { owner = null; draining = false; uncertain = false; } }
  static synchronized void draining(Object value) { if (owner == value) draining = true; }
  static synchronized void uncertain(Object value) { if (owner == value) uncertain = true; }
  static synchronized String hint() {
    if (uncertain) return "A player could not close cleanly. Restart Hypergolic before playing another source.";
    if (draining) return "The previous player is stopping. Try Play again shortly.";
    return "Close the other video or radio player, then try Play again.";
  }
}
