package org.nostrocket.hypergolic.host;

import java.util.List;

/** Actual trusted fixture-upload source; native admission is explicit test data. */
public final class HandoffFixtureSource {
  private final FixtureReleaseAuthority owner = FixtureReleaseTransport.INSTANCE.getOwner$hypergolic_napplet_host_debug();
  private final FixtureReleaseAuthority.Entry row;
  public final String token;
  public final NativeSigningSourceFacade.Capture capture;
  public HandoffFixtureSource(String identity, String unsigned) {
    if (!owner.synchronize(identity, 1, true)) throw new AssertionError(); owner.foreground(true);
    byte[] body = "public completed-source fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    row = owner.prepare("handoff-complete", body, FixtureReleaseAuthority.hash(body), "https://blossom.example.org", "[]");
    if (row == null || !owner.approveUpload(row.token)) throw new AssertionError(); token = row.token;
    capture = new NativeSigningSourceFacade.Capture(identity, unsigned, "Disposable fixture source", List.of("https://blossom.example.org"), owner,
      () -> owner.current(token) == row && owner.uploadApproved(token), () -> owner.claimNativeSigning(token, row, false),
      deadline -> owner.holdSigning(token, row, false, deadline), hold -> owner.signingHeld(token, row, false, hold),
      hold -> owner.resumeSigning(token, row, false, hold));
    capture.sign(() -> "");
  }
  public boolean approved() { return owner.uploadApproved(token); }
  public void nextManifest() {
    if (!owner.uploads.claimTransfer(row.grant)) throw new AssertionError(); byte[] sent = owner.uploads.dispatch(row.grant);
    if (sent == null || !owner.verifyRetrieved(token, sent)) throw new AssertionError(); java.util.Arrays.fill(sent, (byte) 0);
    if (!owner.prepareManifest(token, "immutable native manifest") || owner.approveManifest(token) == null) throw new AssertionError();
  }
  public boolean manifestApproved() { return owner.manifestApproved(token); }
  public void cancelManifest() { owner.cancel(token, true); }
}
