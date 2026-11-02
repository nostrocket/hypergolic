package org.nostrocket.hypergolic.host;

public final class UploadQueueProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Queue check " + checks); }
  public static void main(String[] ignored) {
    var owner = new NativeUploadAuthority(() -> 1L); owner.setForeground(true);
    var sessions = new NativeUploadAuthority.SessionHandle[12]; var requests = new NativeUploadAuthority.RequestHandle[12]; var reviews = new NativeUploadAuthority.Review[12];
    for (int index = 0; index < sessions.length; index++) { sessions[index] = owner.register("realm" + index, "a".repeat(64)); check(sessions[index] != null); }
    for (int index = 0; index < 8; index++) { requests[index] = owner.admit(sessions[index], 0, "https://files.example.com", "text/plain"); check(requests[index] != null); reviews[index] = owner.seal(requests[index]); check(reviews[index] != null); }
    check(owner.admit(sessions[8], 0, "https://files.example.com", "text/plain") == null);
    check(owner.admit(sessions[0], 0, "https://files.example.com", "text/plain") == null);
    owner.focus(sessions[0]); var first = owner.approve(requests[0], reviews[0]); check(first != null);
    owner.focus(sessions[1]); var second = owner.approve(requests[1], reviews[1]); check(second != null);
    owner.focus(sessions[2]); check(owner.approve(requests[2], reviews[2]) == null); check(owner.contains(requests[2]));
    for (int index = 8; index < 10; index++) { requests[index] = owner.admit(sessions[index], 0, "https://files.example.com", "text/plain"); check(requests[index] != null); reviews[index] = owner.seal(requests[index]); check(reviews[index] != null); }
    check(owner.admit(sessions[10], 0, "https://files.example.com", "text/plain") == null);
    owner.cancelGrant(first); check(owner.approve(requests[2], reviews[2]) != null);
    check(owner.admit(sessions[10], 0, "https://files.example.com", "text/plain") != null);
    check(owner.admit(sessions[11], 0, "https://files.example.com", "text/plain") == null);
    owner.setForeground(false); check(!owner.isApproved(second)); owner.setForeground(true);
    check(owner.admit(sessions[0], 0, "https://files.example.com", "text/plain") != null); check(!owner.isApproved(second));
    System.out.println("{\"language\":\"Java\",\"uploadQueueChecks\":"+checks+",\"failed\":0,\"scope\":\"native authority; eight pending and two approved slots, no app journey proof\"}");
  }
}
