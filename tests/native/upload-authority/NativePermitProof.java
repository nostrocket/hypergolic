package org.nostrocket.hypergolic.host;

/** Exact app credential profile checks; signature verification is covered by shared owning tests. */
public final class NativePermitProof {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  public static void main(String[] tokens) {
    var authority = new NativeUploadAuthority(() -> 100);
    var session = authority.register("fixture", "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    authority.setForeground(true); authority.focus(session);
    var request = authority.admit(session, 3, "https://files.example.com", "image/png");
    check(authority.append(request, 0, new byte[]{1,2,3})); var review = authority.seal(request); check(review != null);
    var permit = NativeBlossomPermit.capture(review, tokens[0], 1001); check(permit != null && permit.review == review);
    check(permit.authorization.equals("Nostr " + tokens[0])); check(permit.expiration == 1120);
    check(permit.validAt(1001)); check(permit.validAt(1119));
    for (long now : new long[]{999,1000,1120,-1,Long.MAX_VALUE}) check(!permit.validAt(now));
    for (int i = 1; i < tokens.length; i++) check(NativeBlossomPermit.capture(review, tokens[i], 1001) == null);
    for (long now : new long[]{999,1000,1120,-1,Long.MAX_VALUE}) check(NativeBlossomPermit.capture(review, tokens[0], now) == null);
    check(NativeBlossomPermit.capture(review, tokens[0]+"=", 1001) == null);
    check(NativeBlossomPermit.capture(review, tokens[0]+"\r\nForged: yes", 1001) == null);
    check(NativeBlossomPermit.capture(review, "a".repeat(4097), 1001) == null);
    var grant = authority.approve(request, review); check(authority.approvedReview(grant) == review);
    authority.setForeground(false); authority.setForeground(true); check(authority.approvedReview(grant) == null);
    System.out.println("{\"language\":\"Java\",\"uploadPermitChecks\":"+checks+",\"failed\":0}");
  }
}
