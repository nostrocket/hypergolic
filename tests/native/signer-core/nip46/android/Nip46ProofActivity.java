package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.TextView;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.host.NativeSignerRelayFixture;

/** Disposable owning RPC/WSS fixture. No Expo export, guest lane or publication endpoint. */
public final class Nip46ProofActivity extends Activity {
  private static final String PACKAGE = "org.nostrocket.hypergolic.signercore.nip46proof";
  private final Object owner = new Object();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final NativeReviewPanel panel = new NativeReviewPanel();
  private final AtomicBoolean alive = new AtomicBoolean(true);
  private final JSONArray results = new JSONArray();
  private JSONObject ready, snapshot;
  private byte[] certificate;
  private NativeVault vault;
  private NativeRemoteOperation pending;
  private NativeSignerCore core;
  private NativeRemoteBinding remote;
  private int assertions, index;
  private String user;
  private volatile String lastOutcome = "preparing";
  private final String[] cases = {"none", "direct-null", "string-null", "direct-array", "string-array", "relay-change",
    "changed-event", "wrong-user", "invalid-inner-id", "invalid-inner-signature", "invalid-outer-id",
    "invalid-outer-signature", "bad-mac", "refusal", "auth-url", "close-after-send", "no-response",
    "wrong-id", "wrong-peer", "wrong-recipient", "duplicate", "cancel-at-possible-send", "valid-plus-invalid-suffix", "valid-plus-close-trailing",
    "challenge-sign-denied", "challenge-sign-expired", "challenge-sign-other",
    "challenge-preflight-denied", "challenge-preflight-expired", "challenge-preflight-other"};

  private void check(boolean value) { assertions++; if (!value) throw new AssertionError("Native RPC assertion " + assertions); }
  private void denied(Runnable action) {
    assertions++;
    try { action.run(); } catch (RuntimeException expected) { return; }
    throw new AssertionError("Native RPC denial " + assertions);
  }
  private byte[] asset(String name) throws Exception { try (java.io.InputStream input = getAssets().open(name)) { return input.readAllBytes(); } }
  private void write(String name, JSONObject value) throws Exception {
    File temporary = new File(getFilesDir(), name + ".tmp");
    Files.write(temporary.toPath(), value.toString().getBytes(StandardCharsets.UTF_8));
    if (!temporary.renameTo(new File(getFilesDir(), name))) throw new Exception();
  }
  private NativeRemoteOperation operation(long deadline, NativeSignerCore reviewing, NativeSignerCore.Review review) {
    return new NativeRemoteOperation(deadline, new NativeRemoteOperation.Guard() {
      @Override public void check() {
        if (!alive.get() || reviewing != null && !reviewing.canFinish(owner, review)) throw new NativeVault.Error("AUTHORIZATION_DENIED");
      }
      @Override public void beforeSigningSend() {
        if (reviewing == null) throw new NativeVault.Error("AUTHORIZATION_DENIED");
        check();
      }
    });
  }
  private NativeNip46Client client(NativeRemoteBinding binding, NativeRemoteOperation operation) {
    return new NativeNip46Client(binding, operation, (url, control, budget) ->
      NativeSignerRelayFixture.open(url, control, control.deadline, budget, certificate));
  }
  private void control(JSONObject value) throws Exception {
    URI uri = URI.create(ready.getString("controlURL"));
    if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost())) throw new Exception();
    HttpURLConnection connection = (HttpURLConnection)uri.toURL().openConnection();
    try {
      connection.setConnectTimeout(2000); connection.setReadTimeout(2000);
      connection.setRequestMethod("POST"); connection.setDoOutput(true);
      connection.setRequestProperty("x-fixture-control", ready.getString("nonce"));
      connection.setRequestProperty("content-type", "application/json");
      try (java.io.OutputStream out = connection.getOutputStream()) { out.write(value.toString().getBytes(StandardCharsets.UTF_8)); }
      if (connection.getResponseCode() != 200) throw new Exception();
    } finally { connection.disconnect(); }
  }
  private void openingBudgetCases() throws Exception {
    NativeRemoteOperation operation = operation(SystemClock.elapsedRealtime() + 15_000L, null, null);
    org.nostrocket.hypergolic.host.NativeSignerRelay.Budget budget = org.nostrocket.hypergolic.host.NativeSignerRelay.Budget.forRefresh();
    try {
      for (int index = 0; index < 6; index++) {
        try (org.nostrocket.hypergolic.host.NativeSignerRelay connection = NativeSignerRelayFixture.open(
            ready.getString("relayURL"), operation, operation.deadline, budget, certificate)) { check(connection != null); }
      }
      boolean blocked = false;
      try { NativeSignerRelayFixture.open(ready.getString("relayURL"), operation, operation.deadline, budget, certificate); }
      catch (java.io.IOException expected) { blocked = true; }
      check(blocked);
    } finally { operation.close(); }
  }
  private NativeNip46Client client(NativeRemoteBinding binding, NativeRemoteOperation operation,
      org.nostrocket.hypergolic.host.NativeSignerRelay.Budget budget) {
    return new NativeNip46Client(binding, operation, budget, (url, control, bounds) ->
      NativeSignerRelayFixture.open(url, control, control.deadline, bounds, certificate));
  }
  private void refreshPeerCases() throws Exception {
    control(new JSONObject().put("fault", "none").put("relays", JSONObject.NULL).put("stringRelays", false));
    JSONObject before = new JSONObject(vault.publicSnapshot(owner));
    try (NativeRemoteBinding saved = vault.savedRemote(owner, user, before.getString("vaultId"), before.getLong("revision"))) {
      NativeRemoteOperation query = operation(SystemClock.elapsedRealtime() + 120_000L, null, null);
      try (NativeNip46Client client = client(saved, query, org.nostrocket.hypergolic.host.NativeSignerRelay.Budget.forRefresh())) {
        check(client.publicKey().equals(user));
        check(client.switchRelays().equals(saved.relays));
      } finally { query.close(); }
    }
    check(new JSONObject(vault.publicSnapshot(owner)).toString().equals(before.toString()));
    byte[] scalar = new byte[32]; scalar[31] = 9;
    NativeSigningKey imported = null;
    try {
      imported = NativeSigningKey.importScalar(scalar);
      JSONObject prepared = new JSONObject(vault.prepareImport(owner, imported, before.getString("vaultId"), before.getLong("revision")));
      imported = null;
      before = new JSONObject(vault.commitImport(owner, prepared.getString("handle"), before.getString("vaultId"), before.getLong("revision")));
    } finally { Arrays.fill(scalar, (byte)0); if (imported != null) imported.close(); }
    check(new JSONObject(vault.methods(owner, user, before.getString("vaultId"), before.getLong("revision"))).getString("selectedMethod").equals("local"));
    control(new JSONObject().put("fault", "none").put("relays", new JSONArray().put(ready.getString("changedRelayURL"))));
    try (NativeRemoteBinding saved = vault.savedRemote(owner, user, before.getString("vaultId"), before.getLong("revision"))) {
      String originalClient = saved.client.publicKey();
      NativeRemoteOperation operation = operation(SystemClock.elapsedRealtime() + 120_000L, null, null);
      org.nostrocket.hypergolic.host.NativeSignerRelay.Budget budget = org.nostrocket.hypergolic.host.NativeSignerRelay.Budget.forRefresh();
      NativeRemoteBinding proposed = null;
      try {
        List<String> changed;
        try (NativeNip46Client client = client(saved, operation, budget)) {
          check(client.publicKey().equals(user));
          changed = client.switchRelays();
        }
        check(changed.equals(List.of(ready.getString("changedRelayURL"))));
        proposed = new NativeRemoteBinding(saved.client.copy(), saved.peer, changed);
        try (NativeNip46Client client = client(proposed, operation, budget)) { check(client.publicKey().equals(user)); }
        JSONObject prepared = new JSONObject(vault.prepareRefresh(owner, user, proposed, operation.deadline,
          before.getString("vaultId"), before.getLong("revision")));
        proposed = null;
        snapshot = new JSONObject(vault.commitRefresh(owner, prepared.getString("handle"), before.getString("vaultId"), before.getLong("revision")));
        check(snapshot.getLong("revision") == before.getLong("revision") + 1);
        check(snapshot.getJSONArray("identities").toString().equals(before.getJSONArray("identities").toString()));
        vault.close();
        check(new JSONObject(vault.open(owner)).toString().equals(snapshot.toString()));
        JSONObject metadata = new JSONObject(vault.methods(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision")));
        check(metadata.getString("selectedMethod").equals("local"));
        try (NativeRemoteBinding cold = vault.savedRemote(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision"))) {
          check(cold.client.publicKey().equals(originalClient));
          check(cold.peer.equals(saved.peer));
          check(cold.relays.equals(changed));
        }
      } finally { operation.close(); if (proposed != null) proposed.close(); }
    }
    control(new JSONObject().put("fault", "wrong-public-key").put("method", "get_public_key"));
    try (NativeRemoteBinding saved = vault.savedRemote(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision"))) {
      NativeRemoteOperation operation = operation(SystemClock.elapsedRealtime() + 120_000L, null, null);
      try (NativeNip46Client client = client(saved, operation, org.nostrocket.hypergolic.host.NativeSignerRelay.Budget.forRefresh())) {
        String returned = client.publicKey();
        check(NativeSigningKey.validPublicKey(returned));
        check(!returned.equals(user));
      } finally { operation.close(); }
    }
    check(new JSONObject(vault.publicSnapshot(owner)).toString().equals(snapshot.toString()));
    control(new JSONObject().put("fault", "none"));
  }

  private void cryptoCases() throws Exception {
    byte[] clear = "Native NIP44 UTF8 test \u00e9 \ud83d\ude80".getBytes(StandardCharsets.UTF_8);
    byte[] payload = null, decoded = null;
    try (NativeSigningKey sender = new NativeSigningKey(); NativeSigningKey receiver = new NativeSigningKey()) {
      check(NativeSigningKey.validPublicKey(sender.publicKey()));
      check(!NativeSigningKey.validPublicKey("0".repeat(64)));
      check(!NativeSigningKey.validPublicKey("f".repeat(64)));
      payload = sender.transport(receiver.publicKey(), clear, true);
      decoded = receiver.transport(sender.publicKey(), payload, false);
      check(Arrays.equals(clear, decoded));
      byte[] tampered = payload.clone(); tampered[tampered.length - 3] ^= 1;
      try { denied(() -> receiver.transport(sender.publicKey(), tampered, false)); } finally { Arrays.fill(tampered, (byte)0); }
      denied(() -> NativeRpcJson.parse("{\"id\":\"a\",\"id\":\"b\"}"));
      denied(() -> NativeRpcJson.parse("{\"id\":\"raw\ncontrol\"}"));
      denied(() -> NativeRpcJson.parse("{\"id\":\"\\ud800\"}"));
      char[] invalid = ("bunker://" + "0".repeat(64) + "?relay=wss%3A%2F%2Frelay.example.org").toCharArray();
      try { denied(() -> NativeBunker.parse(invalid)); } finally { Arrays.fill(invalid, '\0'); }
    } finally {
      Arrays.fill(clear, (byte)0);
      if (payload != null) Arrays.fill(payload, (byte)0);
      if (decoded != null) Arrays.fill(decoded, (byte)0);
    }
  }
  private void prepare() {
    new Thread(() -> {
      NativeBunker entry = null;
      NativeRemoteBinding binding = null;
      try {
        cryptoCases(); openingBudgetCases();
        char[] chars = ready.getString("bunkerURL").toCharArray();
        try { entry = NativeBunker.parse(chars); } finally { Arrays.fill(chars, '\0'); }
        binding = new NativeRemoteBinding(new NativeSigningKey(), entry.peer, entry.relays);
        NativeRemoteOperation operation = operation(entry.deadline, null, null);
        pending = operation;
        try (NativeNip46Client client = client(binding, operation)) {
          user = client.connect(entry.secret);
          check(user.equals(ready.getString("userPubkey")));
          check(!user.equals(binding.peer));
          List<String> relays = client.switchRelays();
          check(relays.equals(binding.relays));
        } finally { operation.close(); pending = null; }
        vault = new NativeVault(owner, this);
        JSONObject initial = new JSONObject(vault.open(owner));
        JSONObject candidate = new JSONObject(vault.prepareRemote(owner, user, binding, entry.deadline,
          initial.getString("vaultId"), initial.getLong("revision")));
        binding = null;
        snapshot = new JSONObject(vault.commitRemote(owner, candidate.getString("handle"), initial.getString("vaultId"), initial.getLong("revision")));
        vault.close();
        check(new JSONObject(vault.open(owner)).toString().equals(snapshot.toString()));
        JSONObject metadata = new JSONObject(vault.methods(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision")));
        check(metadata.getString("selectedMethod").equals("nip46"));
        main.post(this::next);
      } catch (Throwable failure) { failed(failure); }
      finally { if (entry != null) entry.close(); if (binding != null) binding.close(); }
    }, "native-nip46-prepare").start();
  }
  private static boolean challengeCase(String lane) { return lane.startsWith("challenge-"); }
  private static boolean preflightChallenge(String lane) { return lane.startsWith("challenge-preflight-"); }
  private static String challengeCode(String lane) {
    if (lane.endsWith("-denied")) return "AUTHORIZATION_DENIED";
    if (lane.endsWith("-expired")) return "SIGNER_EXPIRED";
    return "SIGNER_RESPONSE_INVALID";
  }
  private String expected(String lane) {
    if (challengeCase(lane)) {
      String code = challengeCode(lane);
      return !preflightChallenge(lane) && !lane.endsWith("-other") ? "SIGNER_UNCERTAIN" : code;
    }
    if (Arrays.asList("none", "direct-null", "string-null", "direct-array", "string-array", "duplicate").contains(lane)) return "signed";
    if (lane.equals("relay-change")) return "SIGNER_RELAYS_CHANGED";
    if (lane.equals("auth-url")) return "SIGNER_UNSUPPORTED";
    if (lane.equals("refusal")) return "SIGNER_REJECTED";
    if (Arrays.asList("close-after-send", "no-response", "wrong-id", "wrong-peer", "wrong-recipient", "cancel-at-possible-send", "valid-plus-invalid-suffix", "valid-plus-close-trailing").contains(lane)) return "SIGNER_UNCERTAIN";
    return "SIGNER_RESPONSE_INVALID";
  }
  private void next() {
    if (index == cases.length) {
      new Thread(() -> { try {
        refreshPeerCases();
        write("result.json", new JSONObject().put("status", "passed").put("assertions", assertions)
          .put("nativeReviews", cases.length).put("cases", results).put("peerPubkey", ready.getString("peerPubkey"))
          .put("userPubkey", user).put("scope", "Owning Android vault/JNI/RPC/native review plus controlled WSS/TLS; fixture-only DNS, address and trust ports. No Expo, guest source, connection/refresh API UI or publication claim."));
        main.post(() -> ((TextView)findViewById(android.R.id.text1)).setText("Native NIP46 controlled peer checks passed."));
      } catch (Throwable failure) { failed(failure); } }, "native-refresh-peer").start();
      return;
    }
    String lane = cases[index];
    new Thread(() -> {
      try {
        JSONObject mode = new JSONObject().put("fault", "none").put("relays", JSONObject.NULL).put("stringRelays", false);
        if (lane.equals("direct-array") || lane.equals("string-array")) mode.put("relays", new JSONArray().put(ready.getString("relayURL")));
        if (lane.equals("string-null") || lane.equals("string-array")) mode.put("stringRelays", true);
        if (lane.equals("relay-change")) mode.put("relays", new JSONArray().put(ready.getString("changedRelayURL")));
        if (!Arrays.asList("none", "direct-null", "string-null", "direct-array", "string-array", "relay-change").contains(lane)) {
          mode.put("fault", lane.equals("cancel-at-possible-send") ? "no-response" : lane).put("method", "sign_event");
        }
        if (challengeCase(lane)) {
          mode.put("fault", "auth-url").put("method", preflightChallenge(lane) ? "get_public_key" : "sign_event");
        }
        control(mode);
        main.post(() -> review(lane));
      } catch (Throwable failure) { failed(failure); }
    }, "native-nip46-control").start();
  }
  private void review(String lane) {
    try {
      remote = vault.remoteSigning(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision"));
      core = NativeSignerCore.reviewOnly(owner, user);
      String raw = new JSONObject().put("pubkey", user).put("created_at", 1760000000L).put("kind", 1)
        .put("tags", new JSONArray().put(new JSONArray().put("t").put("native-nip46-proof")))
        .put("content", "Exact native RPC event: " + lane + " \u00e9 \ud83d\ude80\n\\\"").toString();
      NativeSignerCore reviewing = core;
      NativeRemoteBinding binding = remote;
      NativeSignerCore.Review review = reviewing.admit(owner, raw);
      long deadline = SystemClock.elapsedRealtime() + 8000;
      panel.showAsync(this, reviewing, owner, review, "Disposable native NIP46 owning fixture", "Saved NIP46 peer " + binding.peer,
        List.of("No publication"), alive::get, deliver -> {
          NativeEvent event = reviewing.consumeOnce(owner, review);
          denied(() -> reviewing.consumeOnce(owner, review));
          NativeRemoteOperation operation = operation(deadline, reviewing, review);
          pending = operation;
          if (lane.equals("cancel-at-possible-send")) {
            main.postDelayed(new Runnable() { public void run() {
              if (operation.uncertain()) operation.close(); else if (pending == operation) main.postDelayed(this, 20);
            } }, 20);
          }
          new Thread(() -> {
            String outcome;
            String signed = null;
            int[] challenges = {0};
            String beforeAuthorization = null;
            try (NativeNip46Client client = client(binding, operation)) {
              if (challengeCase(lane)) {
                beforeAuthorization = vault.publicSnapshot(owner);
                client.authorization(new NativeNip46Client.Authorization() {
                  @Override public void challenge(String requestId, String url) {
                    check(requestId != null && !requestId.isEmpty());
                    check(url != null && url.startsWith("https://"));
                    check(operation.uncertain() == !preflightChallenge(lane));
                    challenges[0]++;
                    throw new NativeVault.Error(challengeCode(lane));
                  }
                  @Override public void awaitResume(String requestId) { }
                });
              }
              signed = client.sign(event);
              operation.check();
              outcome = "signed";
            } catch (NativeVault.Error error) { outcome = error.code; }
            catch (Throwable failure) { failed(failure); return; }
            finally { operation.close(); }
            try {
              lastOutcome = outcome;
              check(outcome.equals(expected(lane)));
              if (challengeCase(lane)) {
                check(challenges[0] == 1);
                check(signed == null);
                check(operation.uncertain() == !preflightChallenge(lane));
                check(vault.publicSnapshot(owner).equals(beforeAuthorization));
                check(new JSONObject(vault.methods(owner, user, snapshot.getString("vaultId"), snapshot.getLong("revision"))).getString("selectedMethod").equals("nip46"));
              }
              JSONObject result = new JSONObject().put("case", lane).put("outcome", outcome).put("possibleSigningSend", operation.uncertain());
              if (challengeCase(lane)) result.put("authorizationChallenges", challenges[0]).put("signedResultReturned", signed != null);
              if (signed != null) {
                check(NativeSignedEvent.exact(signed, event).equals(signed));
                result.put("unsignedEvent", new JSONObject(raw)).put("signedEvent", new JSONObject(signed));
              }
              results.put(result);
              deliver.accept("Native fixture case complete"); // Completion text only; verified public results are stored separately.
            } catch (Throwable failure) { failed(failure); }
          }, "native-nip46-rpc").start();
        }, completed -> {
          if (completed == null) { failed(new AssertionError("Native owning review cancelled")); return; }
          pending = null;
          reviewing.close(); binding.close(); core = null; remote = null;
          index++;
          main.post(this::next);
        });
    } catch (Throwable failure) { failed(failure); }
  }
  private void failed(Throwable failure) {
    try { write("result.json", new JSONObject().put("status", "failed").put("assertions", assertions)
      .put("case", index < cases.length ? cases[index] : "complete").put("outcome", lastOutcome)
      .put("code", failure instanceof NativeVault.Error ? ((NativeVault.Error)failure).code : "FIXTURE_FAILURE")
      .put("error", failure.getClass().getSimpleName())); }
    catch (Exception ignored) {}
  }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    TextView text = new TextView(this); text.setId(android.R.id.text1); text.setText("Preparing disposable native NIP46 trace."); setContentView(text);
    try {
      if (!PACKAGE.equals(getPackageName())) throw new Exception();
      ready = new JSONObject(new String(asset("fixture.json"), StandardCharsets.UTF_8));
      certificate = asset("fixture.der");
      prepare();
    } catch (Throwable failure) { failed(failure); }
  }
  @Override public void onDestroy() {
    alive.set(false);
    if (pending != null) pending.close();
    panel.cancel();
    if (core != null) core.close();
    if (remote != null) remote.close();
    if (vault != null) vault.close();
    NativeSignerRelayFixture.shutdown();
    super.onDestroy();
  }
}
