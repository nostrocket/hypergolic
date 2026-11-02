package org.nostrocket.hypergolic.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real four-slot owner bound, consumed pairs and recovery; controlled host route and pre-signed fixture. */
public final class OwnerCapacityProof {
  private OwnerCapacityProof() {}
  private static JSONObject receipt(String raw, String expected) throws org.json.JSONException {
    JSONObject result = new JSONObject(raw);
    if (!result.getString("status").equals(expected)) throw new AssertionError(raw);
    return result;
  }
  public static void main(String[] args) throws Exception {
    JSONObject fixture = new JSONObject(Files.readString(Path.of(args[4])));
    JSONObject rawPlan = fixture.getJSONObject("plan");
    JSONArray destinations = new JSONArray(), reviewed = new JSONArray();
    for (int index = 0; index < 6; index++) {
      String relay = "wss://relay.damus.io/proof-" + index;
      destinations.put(relay); reviewed.put(new JSONObject().put("relay", relay));
    }
    rawPlan.getJSONObject("event").put("destinations", destinations);
    rawPlan.put("destinations", reviewed);
    String generation = "capacity", snapshot = fixture.getString("snapshot");
    ApprovalLeaseRegistry registry = ApprovalTransport.INSTANCE.getLeases();
    if (!registry.register(generation)) throw new AssertionError();
    registry.foreground(true); registry.focus(generation, true);
    String token = registry.admit(generation, snapshot, true);
    if (!snapshot.equals(registry.take(token))) throw new AssertionError();
    if (!registry.prepare(token, NativeOutboxPlan.Companion.capture(snapshot, rawPlan.toString())) || !registry.approve(token)) throw new AssertionError();
    OwnerTLSRoute.configure(Integer.parseInt(args[0]), Path.of(args[1]), "capacity", registry, new AtomicBoolean(true));
    ExecutorService workers = Executors.newFixedThreadPool(4);
    List<Future<String>> running = new ArrayList<>();
    String event = fixture.getJSONObject("primary").toString();
    Path release = Path.of(args[5]);
    try {
      for (int index = 0; index < 4; index++) {
        final String relay = destinations.getString(index);
        running.add(workers.submit(() -> OutboxPublicationOwner.INSTANCE.publish(token, "primary", event, relay, () -> true)));
      }
      if (!OwnerTLSRoute.awaitFourSends()) throw new AssertionError("Four sends did not start");
      JSONObject blocked = receipt(OutboxPublicationOwner.INSTANCE.publish(token, "primary", event, destinations.getString(4), () -> true), "cancelled-before-send");
      if (!blocked.getString("reason").equals("publication capacity unavailable") || OwnerTLSRoute.calls() != 4) throw new AssertionError("Capacity reached transport");
      boolean replayDenied = false;
      try { OutboxPublicationOwner.INSTANCE.publish(token, "primary", event, destinations.getString(4), () -> true); }
      catch (IllegalArgumentException denied) { replayDenied = true; }
      if (!replayDenied || OwnerTLSRoute.calls() != 4) throw new AssertionError("Consumed pair replay");
      Files.writeString(release, "release after fifth denied before transport\n");
      JSONArray completed = new JSONArray();
      for (Future<String> result : running) completed.put(receipt(result.get(12, TimeUnit.SECONDS), "accepted"));
      JSONObject recovered = receipt(OutboxPublicationOwner.INSTANCE.publish(token, "primary", event, destinations.getString(5), () -> true), "accepted");
      if (OwnerTLSRoute.calls() != 5) throw new AssertionError("Recovery routing count");
      OwnerTLSRoute.verifyOwnerIdle();
      System.out.println(new JSONObject().put("ownerIdle", true).put("status", "passed").put("mode", "capacity").put("routeCalls", OwnerTLSRoute.calls())
        .put("blocked", blocked).put("replayDenied", replayDenied).put("completed", completed).put("recovered", recovered));
    } finally {
      if (!Files.exists(release)) Files.writeString(release, "release on cleanup\n");
      registry.revoke(generation); workers.shutdownNow();
      if (!workers.awaitTermination(12, TimeUnit.SECONDS)) throw new AssertionError("Publication workers leaked");
      OwnerTLSRoute.close();
    }
  }
}
