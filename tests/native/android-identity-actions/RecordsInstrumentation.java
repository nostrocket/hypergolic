package org.nostrocket.hypergolic.identityowner;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test APK only: observes existing fixture inventory; all mutations use disposable preferences. */
public final class RecordsInstrumentation extends Instrumentation {
  private static final String SERVICE = "org.nostrocket.hypergolic.identity.v1";
  private static final String FIRST = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  private static final String SECOND = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
  private static final String SCALAR_ONE = "0000000000000000000000000000000000000000000000000000000000000001";
  private static final String SCALAR_TWO = "0000000000000000000000000000000000000000000000000000000000000002";
  private int assertions;
  private String step = "start";
  private Bundle arguments;
  private KeyStore.SecretKeyEntry wrappingKey;
  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  private void check(boolean value) { assertions++; if (!value) throw new AssertionError("Native record assertion"); }
  private void denied(Runnable operation) {
    assertions++;
    try { operation.run(); } catch (DeletionAuthority.Denied expected) { return; }
    throw new AssertionError("Expected native record denial");
  }
  private static String slot(String key) { return SERVICE + "-" + key; }
  private String encrypt(String plaintext) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, wrappingKey.getSecretKey());
    byte[] bytes = plaintext.getBytes(StandardCharsets.US_ASCII);
    try {
      return new JSONObject().put("ct", Base64.encodeToString(cipher.doFinal(bytes), Base64.NO_WRAP))
          .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
          .put("tlen", cipher.getParameters().getParameterSpec(GCMParameterSpec.class).getTLen())
          .put("scheme", "aes").put("usesKeystoreSuffix", true).put("keystoreAlias", SERVICE).put("requireAuthentication", false).toString();
    } finally { java.util.Arrays.fill(bytes, (byte) 0); }
  }
  private String secret(String pubkey, String scalar) { return new JSONArray().put("HGK1").put(pubkey).put(scalar).toString(); }
  private String receipt(String selected) {
    return new JSONArray().put("HGI1").put("native_probe_vault_012345").put(1).put(1).put(selected)
        .put(new JSONArray().put(new JSONArray().put(FIRST).put(1).put(1)).put(new JSONArray().put(SECOND).put(2).put(1))).toString();
  }
  private void put(SharedPreferences prefs, String key, String value) { check(prefs.edit().putString(slot(key), value).commit()); }
  private void restore(SharedPreferences prefs, Map<String, String> records) {
    SharedPreferences.Editor edit = prefs.edit().clear();
    for (Map.Entry<String, String> item : records.entrySet()) edit.putString(item.getKey(), item.getValue());
    check(edit.commit());
  }
  private static String token() {
    byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
    StringBuilder result = new StringBuilder(64);
    for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
    java.util.Arrays.fill(bytes, (byte) 0); return result.toString();
  }
  private void invalidEnvelopes(SharedPreferences prefs, Map<String, String> records, SecureStoreIdentityRecords reader) throws Exception {
    Object[][] changes = { {"scheme", "rsa"}, {"keystoreAlias", "other-service"}, {"usesKeystoreSuffix", false},
        {"requireAuthentication", true}, {"tlen", 96}, {"tlen", true}, {"iv", "AA=="}, {"ct", "AAAA"}, {"ct", "not-base64"}, {"extra", "field"} };
    for (Object[] change : changes) {
      restore(prefs, records);
      put(prefs, "secret." + FIRST, new JSONObject(records.get(slot("secret." + FIRST))).put((String) change[0], change[1]).toString());
      denied(reader::read);
    }
    restore(prefs, records);
    JSONObject damaged = new JSONObject(records.get(slot("secret." + FIRST)));
    byte[] ciphertext = Base64.decode(damaged.getString("ct"), Base64.NO_WRAP); ciphertext[0] ^= 1;
    put(prefs, "secret." + FIRST, damaged.put("ct", Base64.encodeToString(ciphertext, Base64.NO_WRAP)).toString()); denied(reader::read);
  }
  private void invalidPayloads(SharedPreferences prefs, Map<String, String> records, SecureStoreIdentityRecords reader) throws Exception {
    String[] payloads = { secret(SECOND, SCALAR_ONE), secret(FIRST, "0".repeat(64)),
        secret(FIRST, "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
        secret(FIRST, "invalid"), secret(FIRST, SCALAR_ONE) + "[]", "[\"HGK1\"]", "[true, false, null]", " ", "[\"HGK1\",\"" + FIRST + "\",\"" + SCALAR_ONE + "\"]\n" };
    for (String payload : payloads) {
      restore(prefs, records); put(prefs, "secret." + FIRST, encrypt(payload)); denied(reader::read);
    }
    restore(prefs, records); put(prefs, "inventory", encrypt(receipt(SCALAR_ONE))); denied(reader::read);
    restore(prefs, records); check(prefs.edit().remove(slot("secret." + FIRST)).commit()); denied(reader::read);
    restore(prefs, records); check(prefs.edit().putString("inventory", "legacy").commit()); denied(reader::read);
    restore(prefs, records); put(prefs, "stage", "unfinished"); denied(reader::read);
    restore(prefs, records); put(prefs, "inventory", " "); denied(reader::read);
  }
  private void nativeEffect(SharedPreferences prefs, Map<String, String> records, SecureStoreIdentityRecords reader) {
    restore(prefs, records);
    DeletionAuthority authority = new DeletionAuthority(reader, SystemClock::elapsedRealtime, RecordsInstrumentation::token);
    authority.activate(); authority.updateForeground(true); String session = authority.beginSettings(SECOND, 1);
    DeletionAuthority.Attempt rejected = authority.begin(session, FIRST, SECOND, 1);
    denied(() -> authority.complete(rejected, false)); check(records.equals(prefs.getAll()));
    String obsolete = authority.complete(authority.begin(session, FIRST, SECOND, 1), true);
    authority.updateForeground(false); authority.updateForeground(true);
    denied(() -> authority.erase(session, FIRST, obsolete, reader::erase)); check(records.equals(prefs.getAll()));
    String current = authority.beginSettings(SECOND, 1);
    String approved = authority.complete(authority.begin(current, FIRST, SECOND, 1), true); // Explicit OS-auth double.
    authority.erase(current, FIRST, approved, reader::erase);
    check(!prefs.contains(slot("secret." + FIRST)) && records.get(slot("secret." + SECOND)).equals(prefs.getString(slot("secret." + SECOND), null)));
    check(records.get(slot("inventory")).equals(prefs.getString(slot("inventory"), null)));
    denied(() -> authority.erase(current, FIRST, approved, reader::erase));
  }
  private void nativeBackup(SharedPreferences prefs, Map<String, String> records, SecureStoreIdentityRecords reader) {
    restore(prefs, records);
    DeletionAuthority authority = new DeletionAuthority(reader, SystemClock::elapsedRealtime, RecordsInstrumentation::token);
    authority.activate(); authority.updateForeground(true);
    String session = authority.beginSettings(SECOND, 1);
    DeletionAuthority.Attempt rejected = authority.beginBackup(session, SECOND, SECOND, 1);
    denied(() -> authority.completeBackup(rejected, false)); check(records.equals(prefs.getAll()));
    DeletionAuthority.BackupLease lease = authority.completeBackup(authority.beginBackup(session, SECOND, SECOND, 1), true); // Explicit OS-auth double.
    char[] revealed = authority.readBackup(lease, reader::backup);
    try {
      check(java.util.Arrays.equals(revealed, "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpqptcfk2".toCharArray()));
      check(records.equals(prefs.getAll()));
      denied(() -> authority.readBackup(lease, reader::backup));
    } finally { java.util.Arrays.fill(revealed, '\0'); authority.closeBackup(lease); }
    DeletionAuthority.Inventory inventory = reader.read();
    denied(() -> reader.backup(SECOND, "0".repeat(64)));
    denied(() -> reader.backup(FIRST, inventory.identities.get(SECOND)));
    DeletionAuthority.BackupLease obsolete = authority.completeBackup(authority.beginBackup(session, SECOND, SECOND, 1), true);
    authority.updateForeground(false);
    denied(() -> authority.readBackup(obsolete, reader::backup));
    check(records.equals(prefs.getAll()));
  }
  @Override public void onStart() {
    Bundle result = new Bundle(); Context context = getTargetContext();
    SharedPreferences actual = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE);
    Map<String, ?> before = new HashMap<>(actual.getAll());
    String disposableName = "HypergolicIdentityRecordsProof." + java.util.UUID.randomUUID();
    SharedPreferences disposable = context.getSharedPreferences(disposableName, Context.MODE_PRIVATE);
    try {
      step = "existing-sdk-records";
      DeletionAuthority.Inventory real = new SecureStoreIdentityRecords(context).read();
      check(real.selected.equals(arguments.getString("selected"))); check(real.identities.size() == 2);
      KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore"); keyStore.load(null);
      wrappingKey = (KeyStore.SecretKeyEntry) keyStore.getEntry("AES/GCM/NoPadding:" + SERVICE + ":keystoreUnauthenticated", null);
      step = "disposable-records";
      Map<String, String> records = Map.of(slot("inventory"), encrypt(receipt(SECOND)),
          slot("secret." + FIRST), encrypt(secret(FIRST, SCALAR_ONE)), slot("secret." + SECOND), encrypt(secret(SECOND, SCALAR_TWO)));
      restore(disposable, records); SecureStoreIdentityRecords reader = new SecureStoreIdentityRecords(disposable);
      DeletionAuthority.Inventory observed = reader.read(); check(observed.selected.equals(SECOND) && observed.identities.size() == 2);
      step = "invalid-envelopes"; invalidEnvelopes(disposable, records, reader);
      step = "invalid-payloads"; invalidPayloads(disposable, records, reader);
      step = "native-effect"; nativeEffect(disposable, records, reader);
      step = "native-backup"; nativeBackup(disposable, records, reader);
      step = "preserve-existing-sdk-records"; check(before.equals(actual.getAll()));
      check(real.equals(new SecureStoreIdentityRecords(context).read()));
      result.putString("result", "passed"); result.putInt("assertions", assertions); result.putBoolean("existingRecordsUnchanged", true);
      result.putString("selectedPublicKey", real.selected); result.putInt("identityCount", real.identities.size());
      result.putString("scope", "Android Keystore, SDK-record compatibility and actual disposable preference erase and native backup encoding; OS authentication is an explicit double.");
    } catch (Throwable ignored) { result.putString("result", "failed"); result.putString("step", step); }
    finally {
      wrappingKey = null;
      if (!context.deleteSharedPreferences(disposableName) || !before.equals(actual.getAll())) result.putString("result", "failed");
    }
    finish("passed".equals(result.getString("result")) ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
  }
}
