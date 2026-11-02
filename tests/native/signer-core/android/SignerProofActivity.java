package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Disposable package only. Production core assertions use explicitly marked native clocks/gestures. */
public final class SignerProofActivity extends Activity {
  private int assertions;
  private final NativeReviewPanel panel = new NativeReviewPanel();
  private NativeSignerCore core;
  private String pubkey, exact, signed;
  private void check(boolean value) { assertions++; if (!value) throw new AssertionError("Native signer assertion " + assertions); }
  private void denied(Runnable action) {
    assertions++;
    try { action.run(); } catch (NativeSignerCore.Denied expected) { return; }
    throw new AssertionError("Expected signer denial " + assertions);
  }
  private static String event(String key, String content) {
    return "{\"pubkey\":\"" + key + "\",\"created_at\":1760000000,\"kind\":1,\"tags\":[[\"t\",\"native-trace\"],[\"x\",\"https://example.org/a/b\"]],\"content\":" + NativeEvent.quote(content) + "}";
  }
  private void write(String name, String value) {
    File temporary = new File(getFilesDir(), name + ".tmp");
    try (java.io.FileOutputStream file = new java.io.FileOutputStream(temporary)) {
      file.write(value.getBytes(StandardCharsets.UTF_8));
    } catch (Exception failure) { throw new RuntimeException(failure); }
    if (!temporary.renameTo(new File(getFilesDir(), name))) throw new RuntimeException("Proof receipt write failed");
  }
  private void coreCases() {
    Object owner = new Object(); long[] clock = {100};
    try (NativeSignerCore subject = new NativeSignerCore(owner, () -> clock[0])) {
      String key = subject.generateDisposableIdentity(owner); check(key.matches("[a-f0-9]{64}"));
      check(key.equals(subject.generateDisposableIdentity(owner)));
      denied(() -> subject.generateDisposableIdentity(new Object()));
      String raw = event(key, "exact / emoji 🚀\nquote \" slash \\ control \u0001");
      NativeEvent captured = NativeEvent.capture(raw, key);
      check(captured.canonical.contains("https://example.org/a/b"));
      check(captured.canonical.contains("🚀"));
      check(captured.canonical.contains("\\u0001"));
      check(captured.content.equals("exact / emoji 🚀\nquote \" slash \\ control \u0001"));
      String[] malformed = {
        raw + "{}", event(key, "bad").replace("\"bad\"", "\"bad\ntext\""), event(key, "bad").replace("\"bad\"", "\"bad\\vtext\""), raw.replace("\"kind\":1", "\"kind\":1,\"kind\":1"), raw.replace("\"kind\":1", "\"kind\":1,\"extra\":true"),
        raw.replace("\"kind\":1", "\"kind\":1.0"), raw.replace("\"kind\":1", "\"kind\":true"), raw.replace("\"kind\":1", "\"kind\":65536"),
        raw.replace("1760000000", "9007199254740992"), raw.replace("1760000000", "-1"), raw.replace("1760000000", "1e3"),
        raw.replace("\"tags\":[", "\"tags\":true,\"invalid\":["), raw.replace("\"native-trace\"", "3"), raw.replace("\"native-trace\"", "null"),
        raw.replace(key, "0".repeat(64)), raw.replace("\"kind\":1,", ""), event(key, "bad").replace("\"bad\"", "\"\\ud800\""),
        event(key, "bad").replace("\"bad\"", "\"\\udc00\""), event(key, "x").replace("\"x\"}", "'x'}")
      };
      for (String item : malformed) denied(() -> NativeEvent.capture(item, key));
      denied(() -> NativeEvent.capture(event(key, "x").replace("\"x\"}", "\"" + "x".repeat(NativeEvent.MAX_BYTES) + "\"}"), key));
      NativeSignerCore.Review review = subject.admit(owner, raw);
      check(review.unsignedEvent().equals(captured.unsigned));
      denied(() -> subject.generateDisposableIdentity(owner));
      denied(() -> subject.admit(owner, event(key, "altered")));
      denied(() -> subject.approveOnce(new Object(), review));
      String result = subject.approveOnce(owner, review); check(result.contains("\"content\":" + NativeEvent.quote(captured.content)));
      denied(() -> subject.approveOnce(owner, review));
      NativeSignerCore.Review rejected = subject.admit(owner, raw); subject.reject(owner, rejected);
      denied(() -> subject.approveOnce(owner, rejected));
      NativeSignerCore.Review cancelled = subject.admit(owner, raw); subject.cancel(owner);
      denied(() -> subject.approveOnce(owner, cancelled));
      NativeSignerCore.Review expired = subject.admit(owner, raw); clock[0] += NativeSignerCore.LIFETIME_MS;
      denied(() -> subject.approveOnce(owner, expired));
      denied(() -> subject.generateDisposableIdentity(owner));
    }
    Object second = new Object(); long[] time = {10};
    NativeSignerCore previous = new NativeSignerCore(second);
    String oldKey = previous.generateDisposableIdentity(second);
    NativeSignerCore.Review stale = previous.admit(second, event(oldKey, "old generation")); previous.background();
    try (NativeSignerCore replacement = new NativeSignerCore(second)) {
      String nextKey = replacement.generateDisposableIdentity(second); check(!oldKey.equals(nextKey));
      denied(() -> replacement.approveOnce(second, stale));
      denied(() -> replacement.admit(second, event(oldKey, "wrong identity")));
      NativeSignerCore.Review current = replacement.admit(second, event(nextKey, "new generation"));
      check(replacement.approveOnce(second, current).contains(nextKey));
    }
    denied(() -> previous.generateDisposableIdentity(second));
    try (NativeSignerCore subject = new NativeSignerCore(second, () -> time[0])) {
      String key = subject.generateDisposableIdentity(second);
      NativeSignerCore.Review review = subject.admit(second, event(key, "rollback")); time[0] = 9;
      denied(() -> subject.approveOnce(second, review)); denied(() -> subject.generateDisposableIdentity(second));
    }
    try (NativeSignerCore subject = new NativeSignerCore(second)) {
      String key = subject.generateDisposableIdentity(second); NativeSignerCore.Review review = subject.admit(second, event(key, "background"));
      subject.background(); denied(() -> subject.approveOnce(second, review)); denied(() -> subject.generateDisposableIdentity(second));
    }
  }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    try {
      coreCases();
      core = new NativeSignerCore(this); pubkey = core.generateDisposableIdentity(this);
      exact = event(pubkey, "Disposable Android native review / 🚀\nExact bytes. No publication.");
      TextView text = new TextView(this); text.setText("Native signer proof\nWaiting for native Approve once input."); text.setTextSize(18); setContentView(text);
      NativeSignerCore.Review review = core.admit(this, exact);
      panel.show(this, core, this, review, () -> !isFinishing(), result -> {
        try {
          check(result != null); signed = result; write("signed-event.json", result);
          denied(() -> core.approveOnce(this, review));
          check(new JSONObject(result).getString("pubkey").equals(pubkey));
          check(new JSONObject(result).getString("content").equals("Disposable Android native review / 🚀\nExact bytes. No publication."));
          TextView status = new TextView(this); status.setText("Native approve observed. Now reject the next request."); setContentView(status);
          NativeSignerCore.Review reject = core.admit(this, event(pubkey, "Reject this disposable request."));
          panel.show(this, core, this, reject, () -> !isFinishing(), deniedResult -> {
            try {
              check(deniedResult == null); denied(() -> core.approveOnce(this, reject));
              JSONObject receipt = new JSONObject().put("status", "passed").put("assertions", assertions)
                .put("environment", "Android emulator; production Java/JNI/panel; disposable native Activity owner")
                .put("limitations", "Core fault cases inject native clocks/approval calls. UI approve/reject use external adb input. Expo AppContext binding is compiled separately.")
                .put("signedEvent", new JSONObject(signed)).put("unsignedEvent", new JSONObject(exact));
              write("result.json", receipt.toString()); status.setText("PASS " + assertions + " assertions"); core.close();
            } catch (Throwable failure) { fail(failure); }
          });
        } catch (Throwable failure) { fail(failure); }
      });
    } catch (Throwable failure) { fail(failure); }
  }
  private void fail(Throwable failure) {
    write("result.json", "{\"status\":\"failed\",\"assertions\":" + assertions + ",\"error\":" + NativeEvent.quote(failure.toString()) + "}");
    TextView error = new TextView(this); error.setText("FAIL " + failure); setContentView(error);
    if (core != null) core.close();
  }
  @Override protected void onDestroy() { panel.cancel(); if (core != null) core.close(); super.onDestroy(); }
}
