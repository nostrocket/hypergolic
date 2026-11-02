package org.nostrocket.hypergolic.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import kotlin.jvm.functions.Function0;
import org.json.JSONObject;

/** Compiled production owner with explicit host clock and route adapters; no Android UI/signing proof. */
public final class OwnerTLSProof {
  private OwnerTLSProof() {}
  public static void main(String[] args) throws Exception {
    String mode = args[3];
    JSONObject fixture = new JSONObject(Files.readString(Path.of(args[4])));
    String generation = "owner-" + mode, snapshot = fixture.getString("snapshot");
    ApprovalLeaseRegistry registry = ApprovalTransport.INSTANCE.getLeases();
    if (!registry.register(generation)) throw new AssertionError("Registration");
    registry.foreground(true); registry.focus(generation, true);
    String token = registry.admit(generation, snapshot, true);
    if (token == null || !snapshot.equals(registry.take(token))) throw new AssertionError("Admission");
    NativeOutboxPlan plan = NativeOutboxPlan.Companion.capture(snapshot, fixture.getJSONObject("plan").toString());
    if (!registry.prepare(token, plan) || !registry.approve(token)) throw new AssertionError("Approval");
    AtomicBoolean active = new AtomicBoolean(true);
    OwnerTLSRoute.configure(Integer.parseInt(args[0]), Path.of(args[1]), mode, registry, active);
    Function0<Boolean> job = active::get;
    long started = System.nanoTime();
    try {
      String raw = OutboxPublicationOwner.INSTANCE.publish(token, "primary", fixture.getJSONObject("primary").toString(), "wss://relay.damus.io/", job);
      JSONObject receipt = new JSONObject(raw);
      Set<String> fields = new HashSet<>();
      receipt.keys().forEachRemaining(fields::add);
      if (!fields.equals(Set.of("relay", "eventId", "status", "reason"))) throw new AssertionError("Receipt fields");
      if (!receipt.getString("eventId").equals(fixture.getJSONObject("primary").getString("id"))) throw new AssertionError("Event identity");
      if (!receipt.getString("relay").equals("wss://relay.damus.io/")) throw new AssertionError("Reviewed relay");
      String expected = mode.equals("accepted") || mode.equals("accepted-close") ? "accepted" : mode.equals("rejected") ? "rejected" : mode.equals("revoke-before-send") || mode.equals("job-cancel-before-send") ? "cancelled-before-send" : "unknown";
      if (!receipt.getString("status").equals(expected)) throw new AssertionError("Expected " + expected + ": " + raw);
      if (expected.equals("accepted") && !receipt.getString("reason").equals("stored")) throw new AssertionError("Accepted reason");
      if (expected.equals("rejected") && !receipt.getString("reason").equals("blocked")) throw new AssertionError("Rejected reason");
      OwnerTLSRoute.verifyOwnerIdle();
      System.out.println(new JSONObject().put("ownerIdle", true).put("elapsedMs", java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).put("mode", mode).put("status", "passed").put("receipt", receipt).put("routeCalls", OwnerTLSRoute.calls()).put("scope", "Compiled owner with test-only route; runtime and clock composition recorded separately; no UI, protected signer or guest proof"));
    } finally {
      registry.revoke(generation); OwnerTLSRoute.close();
    }
  }
}
