package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.TextView;
import android.widget.Button;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.io.FileOutputStream;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Owning controller proof. The liveness and launch ports are explicit native doubles, not Expo ownership. */
public final class NativeAndroidSignerControllerProof extends Activity {
  private static final String PROVIDER = "org.nostrocket.hypergolic.signercore.nip55fixture";
  private final Object owner = new Object();
  private final AtomicBoolean live = new AtomicBoolean(true);
  private final Handler main = new Handler(Looper.getMainLooper());
  private NativeAndroidSignerActivityController controller;
  private Intent sent;
  private int code, assertions, callbacks, activityResults;
  private String value, error, mode;
  private final JSONObject trace = new JSONObject();
  private final long[] clock = {1000};
  private NativeAndroidSignerBinding binding;
  private final NativeAndroidSignerActivityController.Completion completed = (selected, result, failure) -> {
    callbacks++; value = result; error = failure;
  };
  private void check(boolean passed) {
    assertions++;
    if (!passed) throw new AssertionError("Controller assertion " + assertions);
  }
  private void denied(Runnable effect) {
    try { effect.run(); throw new AssertionError("Expected denial"); }
    catch (NativeVault.Error failure) { check("AUTHORIZATION_DENIED".equals(failure.code)); }
  }
  private void start(NativeAndroidSignerActivityController.Completion completion) {
    value = null; error = null;
    controller.request(this, owner, binding, null, clock[0] + 1000, completion);
  }
  private Intent response(String fault) throws Exception {
    return SignerFixtureResponse.respond(sent.getStringExtra("type"), sent.getData().getSchemeSpecificPart(),
        sent.getStringExtra("id"), PROVIDER, fault);
  }
  private void deliver(Intent data) { controller.result(this, owner, code, RESULT_OK, data); }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    mode = getIntent().getStringExtra("mode");
    try {
      binding = NativeAndroidSignerInventory.read(this, PROVIDER);
      check(NativeAndroidSignerInventory.installed(this).stream().anyMatch(binding::sameInstallation));
      if ("model".equals(mode)) model();
      else if ("hook".equals(mode)) hook();
      else if ("picker".equals(mode)) picker();
      else if ("picker-denied".equals(mode)) pickerDenied();
      else if ("hop".equals(mode)) hop();
      else if ("rotation".equals(mode)) rotation();
      else throw new AssertionError("Unknown proof mode");
    } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
  }
  private void model() throws Exception {
    controller = new NativeAndroidSignerActivityController(owner, live::get, () -> clock[0], (activity, intent, requestCode) -> {
      sent = intent; code = requestCode;
    });
    denied(() -> controller.request(this, new Object(), binding, null, 2000, completed));
    denied(() -> controller.request(this, owner, binding, null, 1000, completed));
    denied(() -> controller.request(this, owner, binding, null, 121001, completed));
    start(completed); String firstId = sent.getStringExtra("id"); int firstCode = code;
    check(firstId.matches("[0-9a-f-]{36}"));
    Intent valid = response("Valid result");
    controller.result(this, new Object(), code, RESULT_OK, valid); check(callbacks == 0);
    controller.result(new Activity(), owner, code, RESULT_OK, valid); check(callbacks == 0);
    controller.result(this, owner, code + 1, RESULT_OK, valid); check(callbacks == 0);
    deliver(valid); check(callbacks == 1 && SignerFixtureResponse.publicKey().equals(value) && error == null);
    deliver(valid); check(callbacks == 1);
    start(completed); check(!firstId.equals(sent.getStringExtra("id")) && firstCode != code);
    deliver(valid); check(callbacks == 2 && value == null && "SIGNER_RESPONSE_INVALID".equals(error));
    for (String fault : List.of("Wrong id", "Wrong package", "Unknown extra", "Wrong extra type", "Null result", "Reject")) {
      start(completed); int before = callbacks;
      deliver(fault.equals("Null result") ? null : response(fault));
      check(callbacks == before + 1 && value == null && (fault.equals("Reject") ? "SIGNER_REJECTED" : "SIGNER_RESPONSE_INVALID").equals(error));
    }
    start(completed); controller.result(this, owner, code, RESULT_CANCELED, response("Valid result"));
    check(value == null && "SIGNER_APP_FAILED".equals(error));
    start(completed); clock[0] += 1000; deliver(response("Valid result"));
    check(value == null && "AUTHORIZATION_DENIED".equals(error));
    start(completed); live.set(false); deliver(response("Valid result"));
    check(value == null && "AUTHORIZATION_DENIED".equals(error)); live.set(true);
    start(completed); controller.foreground(false); int cancelled = callbacks;
    deliver(response("Valid result")); check(callbacks == cancelled && value == null && "AUTHORIZATION_DENIED".equals(error));
    denied(() -> start(completed)); controller.foreground(true);
    start(completed); controller.destroyed(new Activity()); check(callbacks == cancelled);
    controller.destroyed(this); check(callbacks == cancelled + 1 && value == null);
    NativeAndroidSignerBinding changed = new NativeAndroidSignerBinding(PROVIDER, List.of("01".repeat(32)));
    controller.request(this, owner, changed, null, clock[0] + 1000, completed);
    check("SIGNER_IDENTITY_CHANGED".equals(error) && value == null);
    NativeEvent event = NativeEvent.capture("{\"pubkey\":\"" + SignerFixtureResponse.publicKey() + "\",\"kind\":1,\"created_at\":1,\"tags\":[[\"test\",\"# ? %25 + é e\\u0301\"]],\"content\":\"Public controller fixture # ? %25\"}", SignerFixtureResponse.publicKey());
    controller.requestSignature(this, owner, binding, event, clock[0] + 1000, completed);
    byte[] original = event.digest.clone(); Arrays.fill(event.digest, (byte) 0);
    deliver(response("Valid result")); check(error == null && value != null);
    trace.put("unsignedEvent", new JSONObject(event.unsigned)).put("signedEvent", new JSONObject(value));
    System.arraycopy(original, 0, event.digest, 0, original.length); Arrays.fill(original, (byte) 0);
    for (String fault : List.of("Changed content", "Wrong user", "Invalid signature")) {
      controller.requestSignature(this, owner, binding, event, clock[0] + 1000, completed);
      deliver(response(fault)); check(value == null && "SIGNER_RESPONSE_INVALID".equals(error));
    }
    inboundBoundary();
    replacement();
  }
  private static int parcelBytes(Intent intent) {
    android.os.Parcel parcel = android.os.Parcel.obtain();
    try { intent.writeToParcel(parcel, 0); return parcel.dataSize(); }
    finally { parcel.recycle(); }
  }
  private void inboundBoundary() throws Exception {
    NativeEvent event = NativeEvent.capture(new JSONObject().put("pubkey", SignerFixtureResponse.publicKey())
        .put("created_at", 1).put("kind", 1).put("tags", new org.json.JSONArray())
        .put("content", "x".repeat(300000)).toString(), SignerFixtureResponse.publicKey());
    controller.requestSignature(this, owner, binding, event, clock[0] + 1000, completed);
    Intent reply = response("Valid result");
    check(parcelBytes(sent) <= NativeAndroidSignerParcel.MAX_BYTES);
    check(parcelBytes(reply) > NativeAndroidSignerParcel.MAX_BYTES);
    check(NativeSignedEvent.exact(reply.getStringExtra("event"), event) != null);
    trace.put("oversizeUnsignedEvent", new JSONObject(event.unsigned)).put("oversizeSignedEvent", new JSONObject(reply.getStringExtra("event")))
        .put("outboundParcelBytes", parcelBytes(sent)).put("inboundParcelBytes", parcelBytes(reply));
    deliver(reply); check(value == null && "SIGNER_RESPONSE_INVALID".equals(error));
  }
  private void replacement() throws Exception {
    start((selected, result, failure) -> {
      completed.complete(selected, result, failure);
      start(completed);
    });
    Intent oldResult = response("Valid result"); int oldCode = code;
    Thread cancellation = new Thread(controller::cancel);
    cancellation.start(); cancellation.join();
    controller.cancel(); // A completion installs B before the queued A cancellation runs.
    check("AUTHORIZATION_DENIED".equals(error) || value == null);
    int before = callbacks, freshCode = code;
    controller.result(this, owner, oldCode, RESULT_OK, oldResult);
    check(callbacks == before && code == freshCode);
    main.post(() -> {
      try {
        check(callbacks == before);
        deliver(response("Valid result")); check(callbacks == before + 1 && error == null && value != null);
        start(completed); live.set(false);
        int previous = callbacks;
        main.postDelayed(() -> {
          try {
            check(callbacks == previous + 1 && value == null && "AUTHORIZATION_DENIED".equals(error));
            live.set(true); start(completed); clock[0] += 1000; int expiryCount = callbacks;
            main.postDelayed(() -> {
              try { check(callbacks == expiryCount + 1 && value == null && "AUTHORIZATION_DENIED".equals(error)); receipt("passed", null); }
              catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
            }, 300);
          }
          catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
        }, 300);
      } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
    });
  }
  private void hook() throws Exception {
    controller = new NativeAndroidSignerActivityController(owner, live::get, () -> clock[0], (activity, intent, requestCode) -> {
      sent = intent; code = requestCode;
    });
    class Episode implements NativeAndroidSignerActivityController.Handoff {
      String id; long until; boolean valid = true; int cancellations, dispatches;
      @Override public void start(String requestId, long deadline, NativeAndroidSignerBinding selected) {
        check(binding.sameInstallation(selected)); id = requestId; until = deadline;
      }
      @Override public boolean current(String requestId, long deadline) { return valid && id.equals(requestId) && until == deadline; }
      @Override public void dispatched() { dispatches++; }
      @Override public void cancel() { cancellations++; valid = false; }
    }
    NativeEvent scopedEvent = NativeEvent.capture(new JSONObject().put("pubkey", SignerFixtureResponse.publicKey()).put("kind", 1).put("created_at", 1).put("tags", new org.json.JSONArray()).put("content", "Public scoped episode").toString(), SignerFixtureResponse.publicKey());
    Episode episode = new Episode();
    controller.requestSignatureScoped(this, owner, binding, scopedEvent, clock[0] + 1000, completed, episode);
    check(episode.dispatches == 1 && episode.id.equals(sent.getStringExtra("id")));
    controller.foreground(false); live.set(false);
    check(callbacks == 0);
    deliver(response("Valid result")); check(callbacks == 1 && value != null && error == null);
    check(episode.cancellations == 0); // Receive success grants no Resume or source permission.
    controller.foreground(true); live.set(true);
    Episode revoked = new Episode();
    controller.requestSignatureScoped(this, owner, binding, scopedEvent, clock[0] + 1000, completed, revoked);
    revoked.valid = false; deliver(response("Valid result"));
    check(callbacks == 2 && value == null && "AUTHORIZATION_DENIED".equals(error));
    check(revoked.cancellations == 1);
    Episode cancelled = new Episode();
    controller.requestSignatureScoped(this, owner, binding, scopedEvent, clock[0] + 1000, completed, cancelled);
    Intent late = response("Valid result"); Runnable stop = controller.cancellation();
    stop.run(); int before = callbacks;
    stop.run(); // Repeating the captured cancellation must not notify the same episode again.
    deliver(late); check(callbacks == before && cancelled.cancellations == 1 && value == null);
    Episode replacement = new Episode();
    controller.requestSignatureScoped(this, owner, binding, scopedEvent, clock[0] + 1000, completed, replacement);
    Intent fresh = response("Valid result");
    stop.run(); // A stale cancellation belongs to the old request, never its replacement.
    check(callbacks == before && replacement.cancellations == 0 && cancelled.cancellations == 1);
    deliver(fresh); check(callbacks == before + 1 && value != null && error == null && replacement.cancellations == 0);
    Episode offMain = new Episode();
    controller.requestSignatureScoped(this, owner, binding, scopedEvent, clock[0] + 1000, completed, offMain);
    int pendingCallbacks = callbacks;
    Runnable offMainStop = controller.cancellation();
    Thread worker = new Thread(offMainStop); worker.start(); worker.join();
    check(offMain.cancellations == 1 && callbacks == pendingCallbacks); // Revocation precedes queued main completion.
    main.post(() -> {
      try {
        check(callbacks == pendingCallbacks + 1 && value == null && "AUTHORIZATION_DENIED".equals(error));
        offMainStop.run();
        check(callbacks == pendingCallbacks + 1 && offMain.cancellations == 1);
        receipt("passed", null);
      } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
    });
  }
  private void picker() {
    controller = new NativeAndroidSignerActivityController(owner, live::get, SystemClock::elapsedRealtime, (activity, intent, requestCode) -> {
      try {
        sent = intent; code = requestCode;
        check(PROVIDER.equals(intent.getPackage())); check("get_public_key".equals(intent.getStringExtra("type")));
        controller.result(this, owner, code, RESULT_OK, response("Valid result"));
      } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
    });
    controller.choosePublicKey(this, owner, SystemClock.elapsedRealtime() + 10000, (selected, result, failure) -> {
      completed.complete(selected, result, failure);
      check(binding.sameInstallation(selected) && result != null && failure == null); receipt("passed", null);
    });
  }
  private void pickerDenied() {
    controller = new NativeAndroidSignerActivityController(owner, live::get, SystemClock::elapsedRealtime,
        (activity, intent, requestCode) -> { sent = intent; code = requestCode; }, () -> live.set(false));
    controller.choosePublicKey(this, owner, SystemClock.elapsedRealtime() + 10000, (selected, result, failure) -> {
      try {
        completed.complete(selected, result, failure);
        check(callbacks == 1 && sent == null && result == null && "AUTHORIZATION_DENIED".equals(failure));
        live.set(true);
        controller.request(this, owner, binding, null, SystemClock.elapsedRealtime() + 10000, completed);
        main.post(() -> {
          try {
            check(callbacks == 1);
            deliver(response("Valid result")); check(callbacks == 2 && value != null && error == null);
            receipt("passed", null);
          } catch (Throwable problem) { receipt("failed", problem.getClass().getSimpleName()); }
        });
      } catch (Throwable problem) { receipt("failed", problem.getClass().getSimpleName()); }
    });
  }
  private void hop() {
    TextView text = new TextView(this); text.setText("Controller provider hop remains denied on background."); setContentView(text);
    controller = new NativeAndroidSignerActivityController(owner, live::get);
    controller.choosePublicKey(this, owner, SystemClock.elapsedRealtime() + 10000, completed);
  }
  private void rotation() {
    Button complete = new Button(this); complete.setText("Complete rotation probe"); setContentView(complete);
    complete.setOnClickListener(view -> finishRotation());
    controller = new NativeAndroidSignerActivityController(owner, live::get, SystemClock::elapsedRealtime, (activity, intent, requestCode) -> {
      sent = intent; code = requestCode;
      receipt("pending", null);
    });
    controller.request(this, owner, binding, null, SystemClock.elapsedRealtime() + 30000, completed);
  }
  private void finishRotation() {
    try {
      check(!binding.sameInstallation(NativeAndroidSignerInventory.read(this, PROVIDER)));
      deliver(response("Valid result")); check(callbacks == 1 && value == null && "SIGNER_IDENTITY_CHANGED".equals(error));
      receipt("passed", null);
    } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
  }
  @Override protected void onPause() {
    super.onPause(); if (controller != null) controller.foreground(false);
  }
  @Override protected void onDestroy() {
    if (controller != null) controller.destroyed(this); super.onDestroy();
  }
  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    try {
      activityResults++; int before = callbacks;
      controller.result(this, owner, requestCode, resultCode, data);
      check("hop".equals(mode) && callbacks == before && callbacks == 1 && value == null && "AUTHORIZATION_DENIED".equals(error));
      receipt("passed", null);
    } catch (Throwable failure) { receipt("failed", failure.getClass().getSimpleName()); }
  }
  private void receipt(String status, String failure) {
    try {
      trace.put("status", status).put("mode", mode).put("assertions", assertions).put("callbacks", callbacks)
          .put("activityResults", activityResults).put("value", value == null ? JSONObject.NULL : value)
          .put("error", error == null ? JSONObject.NULL : error).put("failure", failure == null ? JSONObject.NULL : failure);
      try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), "result.json"))) {
        output.write(trace.toString().getBytes(StandardCharsets.UTF_8));
      }
    } catch (Exception writingFailure) { throw new IllegalStateException(writingFailure); }
  }
}
