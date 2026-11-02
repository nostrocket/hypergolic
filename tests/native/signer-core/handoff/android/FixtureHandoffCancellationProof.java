package org.nostrocket.hypergolic.host;

/** Exact native fixture token/stage cancellation, with deterministic native clock/public body. */
public final class FixtureHandoffCancellationProof {
  private static int assertions;
  private static void check(boolean passed) { assertions++; if (!passed) throw new AssertionError("Fixture cancel " + assertions); }
  public static int run() {
    FixtureReleaseAuthority owner = new FixtureReleaseAuthority(() -> 100);
    check(owner.synchronize("01".repeat(32), 1, true)); owner.foreground(true);
    byte[] body = "public fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    FixtureReleaseAuthority.Entry a = owner.prepare("cancel-proof", body, FixtureReleaseAuthority.hash(body), "https://blossom.example.org", "[]");
    check(a != null); check(owner.approveUpload(a.token)); check(owner.claimNativeSigning(a.token, a, false));
    NativeSigningHold held = owner.holdSigning(a.token, a, false, 1000); check(held != null);
    owner.foreground(false); check(owner.current(a.token) == null); owner.cancel(a.token, false);
    check(!owner.signingHeld(a.token, a, false, held)); owner.foreground(true);
    FixtureReleaseAuthority.Entry b = owner.prepare("cancel-proof", body, FixtureReleaseAuthority.hash(body), "https://blossom.example.org", "[]");
    check(b != null); owner.cancel(a.token, false); check(owner.current(b.token) == b);
    check(owner.approveUpload(b.token)); check(owner.claimNativeSigning(b.token, b, false));
    check(owner.uploads.claimTransfer(b.grant)); byte[] sent = owner.uploads.dispatch(b.grant); check(sent != null);
    check(owner.verifyRetrieved(b.token, sent)); java.util.Arrays.fill(sent, (byte) 0);
    check(owner.prepareManifest(b.token, "immutable public manifest")); check(owner.approveManifest(b.token) != null);
    check(owner.claimNativeSigning(b.token, b, true)); NativeSigningHold manifest = owner.holdSigning(b.token, b, true, 1000);
    check(manifest != null); owner.foreground(false); owner.cancel(b.token, false);
    check(owner.signingHeld(b.token, b, true, manifest)); owner.cancel(b.token, true);
    check(!owner.signingHeld(b.token, b, true, manifest)); return assertions;
  }
  public static void main(String[] args) { System.out.println("{\"status\":\"passed\",\"assertions\":" + run() + "}"); }
}
