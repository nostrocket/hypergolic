package org.nostrocket.hypergolic.host;

/** Execute every cleanup step once. An uncertain first disposal never becomes a successful repeated close. */
final class LiveMP3Cleanup {
  interface Step { void run() throws Exception; }
  private boolean attempted;
  private boolean released;
  synchronized boolean close(Step... steps) {
    if (attempted) return released;
    attempted = true; boolean success = true;
    for (Step step : steps) {
      try { step.run(); } catch (Exception failure) { success = false; }
    }
    released = success;return released;
  }
}
