package org.nostrocket.hypergolic.host;

import android.os.SystemClock;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Owning native source/grant fixture; native admission/user consent inputs are explicit test data. */
public final class HandoffSourceFixture {
  private static final ApprovalLeaseRegistry REGISTRY = ApprovalTransport.INSTANCE.getLeases();
  private static final String GENERATION = java.util.UUID.randomUUID().toString();
  static { if (!REGISTRY.register(GENERATION)) throw new AssertionError(); }
  private final ApprovalLeaseRegistry registry = REGISTRY;
  private final Object metadata = new Object();
  public final String token;
  public final NativeSigningSourceFacade.Capture capture;
  public final AtomicInteger restores = new AtomicInteger(), cancels = new AtomicInteger();
  public HandoffSourceFixture(String identity, String unsigned) {
    String generation = GENERATION;
    registry.foreground(true); registry.focus(generation, true); registry.resume();
    token = registry.admit(generation, unsigned);
    if (token == null || registry.take(token) == null || !registry.prepareSigning(token, metadata) || !registry.approve(token)) throw new AssertionError();
    capture = new NativeSigningSourceFacade.Capture(identity, unsigned, "Disposable native source", List.of("wss://relay.example.org"), registry,
      () -> registry.isApproved(token), () -> registry.claimNativeSigning(token, metadata),
      deadline -> registry.holdSigning(token, metadata, deadline),
      hold -> registry.signingHeld(token, metadata, hold), hold -> {
        boolean restored = registry.resumeSigning(token, metadata, hold);
        if (restored) restores.incrementAndGet();
        return restored;
      });
    capture.sign(() -> "");
  }
  public void foreground(boolean active) { registry.foreground(active); }
  public boolean approved() { return registry.isApproved(token); }
  public void cancel() { cancels.incrementAndGet(); registry.cancel(token); }
}
