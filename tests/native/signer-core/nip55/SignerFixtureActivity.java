package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Parcel;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Test APK only. No network or remembered approval; each result requires its visible native button. */
public final class SignerFixtureActivity extends Activity {
  private String type, payload, id;
  private boolean completed;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    try {
      String clients;
      try (var input = getAssets().open("clients.txt")) { clients = new String(input.readAllBytes(), StandardCharsets.UTF_8); }
      String caller = getCallingPackage();
      if (state != null || caller == null || !java.util.List.of(clients.strip().split("\n")).contains(caller)) {
        throw new IllegalArgumentException("Use the disposable client to request a result.");
      }
      Intent request = getIntent();
      String raw = request.getDataString();
      type = request.getStringExtra("type"); id = request.getStringExtra("id");
      if (!Intent.ACTION_VIEW.equals(request.getAction()) || raw == null || !raw.startsWith("nostrsigner:") ||
          raw.length() > 300_000 || id == null || id.isEmpty() || id.length() > 256 ||
          !("get_public_key".equals(type) || "sign_event".equals(type))) throw new IllegalArgumentException("Invalid fixture request.");
      // Decode the selected Uri.fromParts profile once, preserving encoded percent signs and Unicode.
      payload = request.getData().getSchemeSpecificPart();
      if (type.equals("get_public_key") && !payload.isEmpty()) throw new IllegalArgumentException("Unexpected key payload.");
      if (type.equals("sign_event")) {
        if (!SignerFixtureResponse.publicKey().equals(request.getStringExtra("current_user"))) throw new IllegalArgumentException("Wrong fixture account.");
        NativeEvent.capture(payload, SignerFixtureResponse.publicKey());
      }
      record(new JSONObject().put("stage", "received").put("type", type).put("id", id).put("caller", caller));
      showRequest(caller);
    } catch (Exception failure) {
      TextView message = new TextView(this); message.setText("Fixture request unavailable. Close and use a fresh request."); setContentView(message);
      setResult(RESULT_CANCELED);
    }
  }

  private void showRequest(String caller) {
    LinearLayout column = new LinearLayout(this); column.setOrientation(LinearLayout.VERTICAL); column.setPadding(32, 64, 32, 32);
    TextView description = new TextView(this);
    description.setText("Disposable NIP-55 signer\nPublic test key only\n\n" + type + "\n" + caller + "\nRequest: " + id + "\n\n" + SignerFixtureResponse.publicKey());
    column.addView(description);
    Spinner modes = new Spinner(this);
    ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, SignerFixtureResponse.MODES);
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); modes.setAdapter(adapter); column.addView(modes);
    Button send = new Button(this); send.setText("Return fixture result"); column.addView(send);
    send.setOnClickListener(view -> {
      if (completed) return;
      completed = true; send.setEnabled(false); modes.setEnabled(false);
      respond((String) modes.getSelectedItem(), description);
    });
    ScrollView scroll = new ScrollView(this); scroll.addView(column); setContentView(scroll);
  }

  private void respond(String mode, TextView status) {
    try {
      if (mode.equals("Leave pending")) { record(new JSONObject().put("stage", "pending").put("id", id)); status.setText("Fixture request remains pending."); return; }
      if (mode.equals("Crash")) { record(new JSONObject().put("stage", "crash").put("id", id)); android.os.Process.killProcess(android.os.Process.myPid()); return; }
      Intent result = mode.equals("Null result") ? null : mode.equals("App failure") ? new Intent().putExtra("id", id) :
          SignerFixtureResponse.respond(type, payload, id, getPackageName(), mode);
      int code = mode.equals("App failure") ? RESULT_CANCELED : RESULT_OK;
      JSONObject receipt = new JSONObject().put("stage", "returned").put("type", type).put("id", id).put("mode", mode).put("resultCode", code);
      if (result != null) {
        Parcel bytes = Parcel.obtain();
        try { result.writeToParcel(bytes, 0); receipt.put("parcelBytes", bytes.dataSize()); }
        finally { bytes.recycle(); }
        if (!mode.equals("Large reply") && !mode.equals("Wrong extra type")) {
          receipt.put("event", result.getStringExtra("event")); receipt.put("result", result.getStringExtra("result"));
        }
      }
      record(receipt); setResult(code, result); finish();
    } catch (Exception failure) { setResult(RESULT_CANCELED); finish(); }
  }

  private void record(JSONObject entry) throws Exception {
    if (getFileStreamPath("events.jsonl").length() > 1024 * 1024) throw new IllegalStateException("Fixture log full.");
    try (var output = openFileOutput("events.jsonl", MODE_APPEND)) {
      output.write((entry.toString() + "\n").getBytes(StandardCharsets.UTF_8));
    }
  }
}
