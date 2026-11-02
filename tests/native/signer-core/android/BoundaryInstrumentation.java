package org.nostrocket.hypergolic.signercore.proof;

import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test APK only: seeds public disposable scalar bytes under the disposable target UID. Never exported in production. */
public final class BoundaryInstrumentation extends Instrumentation {
  private static final String TARGET = "org.nostrocket.hypergolic.signercore.bridgeproof";
  private static final String SERVICE = "org.nostrocket.hypergolic.identity.v1";
  private static final String ALIAS = "AES/GCM/NoPadding:" + SERVICE + ":keystoreUnauthenticated";
  private Bundle arguments;
  @Override public void onCreate(Bundle value) { arguments = value; start(); }
  @Override public void onStart() {
    Bundle result = new Bundle();
    try {
      Context context = getTargetContext();
      if (!TARGET.equals(context.getPackageName())) throw new IllegalStateException("Disposable target required");
      String mode = arguments.getString("mode");
      if ("seed".equals(mode)) seed(context);
      else if (!"inspect".equals(mode)) throw new IllegalArgumentException("Explicit test mode required");
      JSONObject inventory = inventory(context);
      if (inventory.getJSONObject("records").length() != 3 || inventory.getJSONArray("aliases").length() != 1) throw new IllegalStateException("Nonempty fixture inventory required");
      result.putString("inventory", inventory.toString());
      result.putString("status", "passed");
      finish(0, result);
    } catch (Exception failure) {
      result.putString("status", "failed");
      result.putString("error", "Native disposable boundary probe failed");
      finish(1, result);
    }
  }
  private void seed(Context context) throws Exception {
    SharedPreferences preferences = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE);
    KeyStore keystore = KeyStore.getInstance("AndroidKeyStore"); keystore.load(null);
    if (keystore.containsAlias(ALIAS) || !preferences.getAll().isEmpty()) throw new IllegalStateException("Fresh disposable app required");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
    javax.crypto.SecretKey key = generator.generateKey();
    byte[] disposable = new byte[32]; disposable[31] = 3;
    try {
      SharedPreferences.Editor editor = preferences.edit();
      for (String name : new String[]{"inventory", "stage", "secret." + "01".repeat(32)}) {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(disposable);
        try {
          JSONObject record = new JSONObject().put("scheme", "aes").put("keystoreAlias", SERVICE)
            .put("requireAuthentication", false).put("usesKeystoreSuffix", true)
            .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).put("tagLength", 128)
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP));
          editor.putString(SERVICE + "-" + name, record.toString());
        } finally { Arrays.fill(encrypted, (byte)0); }
      }
      if (!editor.commit()) throw new IllegalStateException("Fixture commit failed");
    } finally { Arrays.fill(disposable, (byte)0); }
  }
  private JSONObject inventory(Context context) throws Exception {
    JSONObject rows = new JSONObject();
    for (Map.Entry<String, ?> row : context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).getAll().entrySet()) {
      if (!row.getKey().startsWith(SERVICE + "-")) continue;
      byte[] bytes = row.getValue().toString().getBytes(StandardCharsets.UTF_8);
      try {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder value = new StringBuilder(); for (byte b : digest) value.append(String.format("%02x", b & 255));
        rows.put(row.getKey(), value.toString());
      } finally { Arrays.fill(bytes, (byte)0); }
    }
    KeyStore keystore = KeyStore.getInstance("AndroidKeyStore"); keystore.load(null);
    java.util.List<String> names = Collections.list(keystore.aliases()); Collections.sort(names);
    JSONArray aliases = new JSONArray(); for (String name : names) if (name.contains(SERVICE)) aliases.put(name);
    return new JSONObject().put("records", rows).put("aliases", aliases);
  }
}
