package org.nostrocket.hypergolic.host;

/** Native-only, original-deadline source preservation. This object never grants a storage permit. */
final class NativeSigningHold {
  final long deadline;
  private boolean alive = true, left, returned, resumed;
  NativeSigningHold(long deadline) { this.deadline = deadline; }
  boolean active(long now) { return alive && now >= 0 && now < deadline; }
  boolean pending(long now) { return active(now) && !resumed; }
  boolean resumed(long now) { return active(now) && resumed; }
  void background() {
    if (resumed || returned) alive = false;
    else left = true; // User-leave and background callbacks belong to the same episode.
  }
  void foreground() { if (left) returned = true; }
  boolean resume(long now) {
    if (!pending(now) || !left || !returned) return false;
    resumed = true;
    return true;
  }
}
