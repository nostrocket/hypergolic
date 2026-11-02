package org.nostrocket.hypergolic.signercore;

/** Process-only original-operation ticket. It never changes the native session's current epoch. */
final class NativeHandoffTicket {
  final long originalEpoch, deadline;
  final String requestId;
  private final Object owner, operation;
  private boolean alive = true, left, returned, resumed, verified;

  NativeHandoffTicket(Object owner, Object operation, long originalEpoch, long deadline, String requestId) {
    if (owner == null || operation == null || originalEpoch < 0 || deadline < 1 || requestId == null || requestId.isEmpty()) {
      throw new IllegalArgumentException("Invalid native handoff");
    }
    this.owner = owner; this.operation = operation; this.originalEpoch = originalEpoch;
    this.deadline = deadline; this.requestId = requestId;
  }
  synchronized String state(Object expectedOwner, Object expectedOperation, long now) {
    if (!alive || owner != expectedOwner || operation != expectedOperation || now < 0 || now >= deadline) return null;
    return resumed ? "resumed" : "pending";
  }
  synchronized void background() {
    if (resumed || returned) alive = false;
    else left = true;
  }
  synchronized void foreground() { if (alive && left) returned = true; }
  synchronized boolean resume(Object expectedOwner, Object expectedOperation, long now) {
    if (!"pending".equals(state(expectedOwner, expectedOperation, now)) || !left || !returned || !verified) return false;
    resumed = true;
    return true;
  }
  synchronized boolean verifiedResult(Object expectedOwner, Object expectedOperation, String id, long now) {
    if (!"pending".equals(state(expectedOwner, expectedOperation, now)) || verified || !requestId.equals(id)) return false;
    verified = true;
    return true;
  }
  synchronized boolean readyForResume() { return alive && verified && left && returned && !resumed; }
  synchronized void cancel() { alive = false; }
}
