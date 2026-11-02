package org.nostrocket.hypergolic.identityowner;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import android.os.Process;
import android.security.keystore.KeyInfo;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test APK only. No owner app target, secret result, auth double or production receiver. */
public final class StorageFaultInstrumentation extends Instrumentation {
  private static final String TARGET = "org.nostrocket.hypergolic.identitystorageprobe";
  private static final String SERVICE = "org.nostrocket.hypergolic.identity.v1";
  private static final String ALIAS = "AES/GCM/NoPadding:" + SERVICE + ":keystoreUnauthenticated";
  private static final String CHALLENGE = "Hypergolic disposable storage continuity challenge v1";
  private Bundle args;
  private Context context;
  private SharedPreferences prefs;
  private int assertions;
  private String step = "target";
  private void check(boolean value) { assertions++; if (!value) throw new AssertionError("Storage proof failed"); }
  private static String slot(String name) { return SERVICE + "-" + name; }
  @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); args = arguments; start(); }
  private static byte[] read(File file, int bound) throws Exception {
    if (file.length() > bound || !file.isFile()) throw new IllegalStateException("Bounded file required");
    try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] block = new byte[8192]; int n;
      while ((n = input.read(block)) != -1) { if (out.size() + n > bound) throw new IllegalStateException("File bound"); out.write(block, 0, n); }
      Arrays.fill(block, (byte) 0); return out.toByteArray();
    }
  }
  private static String hash(byte[] data) throws Exception {
    StringBuilder result = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    return result.toString();
  }
  private static String hash(String text) throws Exception { return hash(text.getBytes(StandardCharsets.UTF_8)); }
  private static List<String> names(JSONObject value) {
    List<String> result = new ArrayList<>(); value.keys().forEachRemaining(result::add); return result;
  }
  private JSONObject records() throws Exception {
    JSONObject value = new JSONObject();
    for (Map.Entry<String, ?> e : new TreeMap<>(prefs.getAll()).entrySet()) {
      check(e.getValue() instanceof String); value.put(e.getKey(), e.getValue());
    }
    return value;
  }
  private File baselineFile() { return new File(context.getNoBackupFilesDir(), "disposable-storage-proof.json"); }
  private File faultFile() { return new File(context.getNoBackupFilesDir(), "disposable-storage-fault.json"); }
  private void write(File file, JSONObject value) throws Exception {
    check(file.getCanonicalPath().startsWith(context.getNoBackupFilesDir().getCanonicalPath() + File.separator));
    try (FileOutputStream output = new FileOutputStream(file)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
  }
  private JSONObject load(File file) throws Exception { return new JSONObject(new String(read(file, 65536), StandardCharsets.UTF_8)); }
  private KeyStore store() throws Exception { KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore"); keyStore.load(null); return keyStore; }
  private KeyStore.SecretKeyEntry key() throws Exception { return (KeyStore.SecretKeyEntry) store().getEntry(ALIAS, null); }
  private String aliases() throws Exception {
    KeyStore keyStore = store(); List<String> values = Collections.list(keyStore.aliases()); Collections.sort(values);
    JSONObject result = new JSONObject();
    for (String value : values) result.put(value, keyStore.getCreationDate(value).getTime());
    return result.toString();
  }
  private JSONObject encryptChallenge() throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key().getSecretKey());
    return new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
      .put("ct", Base64.encodeToString(cipher.doFinal(CHALLENGE.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
  }
  private byte[] decrypt(JSONObject value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key().getSecretKey(), new GCMParameterSpec(128, Base64.decode(value.getString("iv"), Base64.NO_WRAP)));
    return cipher.doFinal(Base64.decode(value.getString("ct"), Base64.NO_WRAP));
  }
  private String metadata() throws Exception {
    File file = new File(context.getFilesDir(), "SQLite/hypergolic-identity-v1.db"); check(file.isFile());
    try (SQLiteDatabase db = SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
         Cursor cursor = db.rawQuery("SELECT singleton, revision, payload FROM vault_metadata ORDER BY singleton", null)) {
      check(cursor.moveToFirst()); check(cursor.getInt(0) == 1);
      String record = cursor.getLong(1) + ":" + cursor.getString(2); check(!cursor.moveToNext()); return hash(record);
    }
  }
  private String expected() { String value = args.getString("selected"); check(value != null && value.matches("[0-9a-f]{64}")); return value; }
  private DeletionAuthority.Inventory inventory() {
    DeletionAuthority.Inventory value = new SecureStoreIdentityRecords(context).read();
    check(value.selected.equals(expected()) && value.identities.size() == 1); return value;
  }
  private void denied() {
    assertions++;
    try { new SecureStoreIdentityRecords(context).read(); }
    catch (DeletionAuthority.Denied wanted) { return; }
    throw new AssertionError("Fault admitted");
  }
  private static boolean contains(byte[] bytes, byte[] needle) {
    outer: for (int i = 0; i + needle.length <= bytes.length; i++) {
      for (int j = 0; j < needle.length; j++) if (bytes[i + j] != needle[j]) continue outer;
      return true;
    }
    return false;
  }
  private void collect(File folder, List<File> files, int depth) throws Exception {
    check(depth < 14); File[] children = folder.listFiles(); check(children != null);
    for (File child : children) {
      check(!Files.isSymbolicLink(child.toPath()));
      check(child.getCanonicalPath().startsWith(context.getDataDir().getCanonicalPath() + File.separator));
      if (child.isDirectory()) collect(child, files, depth + 1); else if (child.isFile()) files.add(child);
    }
  }
  private void secretAbsence(Bundle result) throws Exception {
    step = "bounded-private-development-key-absence"; DeletionAuthority.Inventory value = inventory();
    byte[] clear = decrypt(new JSONObject(prefs.getString(slot("secret." + value.selected), null)));
    List<byte[]> patterns = new ArrayList<>();
    try {
      JSONArray payload = new JSONArray(new String(clear, StandardCharsets.US_ASCII));
      check(payload.length() == 3 && payload.getString(0).equals("HGK1") && payload.getString(1).equals(value.selected));
      String scalar = payload.getString(2); check(scalar.matches("[0-9a-f]{64}"));
      byte[] raw = new byte[32];
      for (int i = 0; i < 32; i++) raw[i] = (byte) Integer.parseInt(scalar.substring(i * 2, i * 2 + 2), 16);
      patterns.add(raw); patterns.add(scalar.getBytes(StandardCharsets.US_ASCII));
      patterns.add(scalar.toUpperCase(java.util.Locale.ROOT).getBytes(StandardCharsets.US_ASCII));
      char[] nsec = BackupNsec.encode(raw);
      try { patterns.add(new String(nsec).getBytes(StandardCharsets.US_ASCII)); } finally { Arrays.fill(nsec, '\0'); }
      patterns.add(Base64.encode(raw, Base64.NO_WRAP));
      List<File> files = new ArrayList<>();
      for (String name : new String[]{"files", "cache", "no_backup", "shared_prefs", "databases", "code_cache", "app_webview"}) {
        File folder = new File(context.getDataDir(), name); if (folder.isDirectory()) collect(folder, files, 0);
      }
      long total = 0;
      for (File file : files) {
        byte[] contents = read(file, 32 * 1024 * 1024);
        try {
          total += contents.length; check(total <= 128 * 1024 * 1024);
          for (byte[] pattern : patterns) check(!contains(contents, pattern));
        } finally { Arrays.fill(contents, (byte) 0); }
      }
      result.putInt("scannedPrivateFiles", files.size()); result.putLong("scannedPrivateBytes", total);
      step = "bounded-own-uid-log-absence";
      java.lang.Process process = new ProcessBuilder("logcat", "-d", "--uid=" + Process.myUid(), "-b", "all", "-v", "brief").redirectErrorStream(true).start();
      ByteArrayOutputStream logs = new ByteArrayOutputStream(); byte[] block = new byte[8192];
      try {
        int count;
        while ((count = process.getInputStream().read(block)) != -1) { check(logs.size() + count <= 16 * 1024 * 1024); logs.write(block, 0, count); }
        check(process.waitFor(8, TimeUnit.SECONDS) && process.exitValue() == 0);
        byte[] contents = logs.toByteArray();
        try { for (byte[] pattern : patterns) check(!contains(contents, pattern)); result.putInt("scannedOwnUidLogBytes", contents.length); }
        finally { Arrays.fill(contents, (byte) 0); }
      } finally { Arrays.fill(block, (byte) 0); process.destroy(); logs.reset(); }
      result.putBoolean("boundedGeneratedKeyPlaintextAbsence", true);
    } finally { Arrays.fill(clear, (byte) 0); for (byte[] pattern : patterns) Arrays.fill(pattern, (byte) 0); }
  }
  private void protection(Bundle result) throws Exception {
    step = "native-keystore-protection"; KeyStore.SecretKeyEntry entry = key(); check(entry != null);
    check(entry.getSecretKey().getEncoded() == null);
    KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(entry.getSecretKey().getAlgorithm(), "AndroidKeyStore").getKeySpec(entry.getSecretKey(), KeyInfo.class);
    check(info.getKeySize() == 256); check(!info.isUserAuthenticationRequired());
    result.putInt("keySecurityLevel", info.getSecurityLevel()); result.putBoolean("wrappingKeyNonexportable", true);
    result.putBoolean("systemAuthPerStorageRead", info.isUserAuthenticationRequired());
  }
  private void snapshot(Bundle result) throws Exception {
    step = "actual-sdk-inventory"; inventory(); check(!baselineFile().exists() && !faultFile().exists()); protection(result);
    JSONObject records = records();
    JSONObject baseline = new JSONObject().put("records", records).put("metadata", metadata()).put("aliases", aliases())
      .put("selected", expected()).put("challenge", encryptChallenge());
    write(baselineFile(), baseline); result.putString("baselineCiphertextSha256", hash(records.toString()));
    result.putString("metadataSha256", baseline.getString("metadata")); secretAbsence(result);
  }
  private void restore() throws Exception {
    step = "restore-owned-ciphertext-snapshot"; JSONObject saved = load(baselineFile()); check(saved.getString("selected").equals(expected()));
    byte[] opened = decrypt(saved.getJSONObject("challenge"));
    try { check(new String(opened, StandardCharsets.UTF_8).equals(CHALLENGE)); } finally { Arrays.fill(opened, (byte) 0); }
    check(aliases().equals(saved.getString("aliases")));
    SharedPreferences.Editor edit = prefs.edit().clear(); JSONObject original = saved.getJSONObject("records");
    for (String name : names(original)) edit.putString(name, original.getString(name));
    check(edit.commit()); check(records().toString().equals(original.toString())); check(metadata().equals(saved.getString("metadata"))); inventory();
    if (faultFile().exists()) check(faultFile().delete());
  }
  private void fault(String mode, Bundle result) throws Exception {
    restore(); step = "apply-owned-" + mode; JSONObject before = load(baselineFile());
    String secret = slot("secret." + expected()), receipt = slot("inventory"); SharedPreferences.Editor edit = prefs.edit();
    if (mode.equals("corrupt-inventory") || mode.equals("corrupt-secret")) {
      String target = mode.equals("corrupt-inventory") ? receipt : secret;
      JSONObject changed = new JSONObject(prefs.getString(target, null)); byte[] bytes = Base64.decode(changed.getString("ct"), Base64.NO_WRAP);
      try { bytes[0] ^= 1; changed.put("ct", Base64.encodeToString(bytes, Base64.NO_WRAP)); } finally { Arrays.fill(bytes, (byte) 0); }
      edit.putString(target, changed.toString()); check(edit.commit());
    } else if (mode.equals("missing-inventory") || mode.equals("missing-secret")) {
      edit.remove(mode.equals("missing-inventory") ? receipt : secret); check(edit.commit());
    } else if (mode.equals("legacy-inventory")) { edit.putString(receipt, "legacy-invalid-envelope"); check(edit.commit()); }
    else if (mode.equals("missing-wrapping-key")) { store().deleteEntry(ALIAS); check(!store().containsAlias(ALIAS)); }
    else throw new IllegalArgumentException("Unsupported disposable fault");
    denied(); JSONObject applied = new JSONObject().put("mode", mode).put("records", records()).put("aliases", aliases()).put("metadata", metadata());
    write(faultFile(), applied); check(applied.getString("metadata").equals(before.getString("metadata")));
    result.putString("faultMode", mode); result.putString("faultCiphertextSha256", hash(applied.getJSONObject("records").toString()));
  }
  private void checkpoint(Bundle result) throws Exception {
    step = "whole-app-failed-startup-native-checkpoint"; JSONObject saved = load(baselineFile()), applied = load(faultFile());
    String mode = applied.getString("mode"); check(saved.getString("selected").equals(expected())); denied();
    check(metadata().equals(saved.getString("metadata"))); check(aliases().equals(applied.getString("aliases")));
    JSONObject current = records();
    if (!mode.equals("missing-wrapping-key")) {
      JSONObject original = applied.getJSONObject("records");
      // Pinned Expo57.0.3 removes the exact unreadable entry on BadPaddingException.
      // No replacement or other record change is permitted by this oracle.
      if (mode.equals("corrupt-inventory") || mode.equals("corrupt-secret")) {
        String allowed = mode.equals("corrupt-inventory") ? slot("inventory") : slot("secret." + expected());
        for (String name : names(current)) check(original.has(name) && original.getString(name).equals(current.getString(name)));
        for (String name : names(original)) if (!name.equals(allowed)) check(current.has(name) && current.getString(name).equals(original.getString(name)));
        result.putBoolean("sdkRemovedExactUnreadableEntry", !current.has(allowed));
      } else check(current.toString().equals(original.toString()));
      byte[] opened = decrypt(saved.getJSONObject("challenge"));
      try { check(new String(opened, StandardCharsets.UTF_8).equals(CHALLENGE)); } finally { Arrays.fill(opened, (byte) 0); }
    } else {
      check(!store().containsAlias(ALIAS)); JSONObject original = applied.getJSONObject("records");
      for (String name : names(current)) check(original.has(name) && original.getString(name).equals(current.getString(name)));
      for (String name : names(original)) if (!name.equals(slot("inventory"))) check(current.has(name) && current.getString(name).equals(original.getString(name)));
      result.putBoolean("sdkRemovedExactUnreadableEntry", !current.has(slot("inventory")));
    }
    result.putString("faultMode", mode); result.putString("metadataSha256", saved.getString("metadata"));
    result.putBoolean("noNewWrappingAliasOrMetadataIdentity", true); result.putBoolean("previousWrappingChallengeStillDecrypts", !mode.equals("missing-wrapping-key"));
  }
  @Override public void onStart() {
    Bundle result = new Bundle();
    try {
      context = getTargetContext(); check(context.getPackageName().equals(TARGET)); expected();
      prefs = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE); String mode = args.getString("mode");
      check(mode != null);
      if (mode.equals("snapshot")) snapshot(result);
      else if (mode.equals("checkpoint")) checkpoint(result);
      else if (mode.equals("restore")) { restore(); protection(result); secretAbsence(result); }
      else fault(mode, result);
      result.putString("result", "passed"); result.putInt("assertions", assertions); result.putString("selectedPublicKey", expected());
      result.putString("scope", "Disposable normal-Expo SDK ciphertext/native-reader and whole-app fault checkpoint. No owner app access, OS-auth proof, reboot or unlimited plaintext/log/crash absence claim. Mutable buffers wiped; Java/JSON Strings are not zeroized.");
    } catch (Throwable ignored) { result.putString("result", "failed"); result.putString("step", step); }
    finish("passed".equals(result.getString("result")) ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
  }
}
