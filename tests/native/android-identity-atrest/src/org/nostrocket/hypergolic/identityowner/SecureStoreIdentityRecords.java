package org.nostrocket.hypergolic.identityowner;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed-service compatibility reader for Expo SecureStore 57.0.3; never creates or replaces a key. */
final class SecureStoreIdentityRecords implements DeletionAuthority.InventoryReader {
  private static final String SERVICE = "org.nostrocket.hypergolic.identity.v1";
  private static final String ALIAS = "AES/GCM/NoPadding:" + SERVICE + ":keystoreUnauthenticated";
  private static final String CURVE_ORDER = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
  private static final Set<String> ENCRYPTED_FIELDS = new HashSet<>(Arrays.asList("ct", "iv", "tlen", "scheme", "usesKeystoreSuffix", "keystoreAlias", "requireAuthentication"));
  private final SharedPreferences preferences;
  SecureStoreIdentityRecords(Context context) {
    this(context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE));
  }
  /** Native test seam for disposable preference records, never exposed through Expo. */
  SecureStoreIdentityRecords(SharedPreferences preferences) { this.preferences = preferences; }
  private static void require(boolean valid) { if (!valid) throw new DeletionAuthority.Denied(); }
  private static String slot(String key) { return SERVICE + "-" + key; }
  private String encrypted(String key) {
    require(!preferences.contains(key)); // No legacy-key fallback or implicit migration in an authenticated action.
    String value = preferences.getString(slot(key), null);
    require(value != null && value.length() <= 4096);
    return value;
  }
  private static byte[] base64(Object value, int maximum) {
    require(value instanceof String);
    String text = (String) value;
    require(text.length() <= maximum * 2 && text.matches("[A-Za-z0-9+/]+={0,2}"));
    byte[] result = Base64.decode(text, Base64.NO_WRAP);
    require(result.length <= maximum && Base64.encodeToString(result, Base64.NO_WRAP).equals(text));
    return result;
  }
  private static String digest(String text) throws Exception {
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(64);
    for (byte value : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
    return result.toString();
  }
  private static long integer(Object value) {
    require(value instanceof Number);
    double number = ((Number) value).doubleValue();
    require(Double.isFinite(number) && number >= 0 && number <= DeletionAuthority.MAX_REVISION && number == Math.rint(number));
    return (long) number;
  }
  private static JSONArray plaintext(String encoded, KeyStore.SecretKeyEntry entry) throws Exception {
    JSONObject value = new JSONObject(encoded);
    require(value.toString().equals(encoded));
    Set<String> fields = new HashSet<>(); value.keys().forEachRemaining(fields::add);
    require(fields.equals(ENCRYPTED_FIELDS) && "aes".equals(value.get("scheme"))
        && SERVICE.equals(value.get("keystoreAlias")) && Boolean.TRUE.equals(value.get("usesKeystoreSuffix"))
        && Boolean.FALSE.equals(value.get("requireAuthentication")) && integer(value.get("tlen")) == 128);
    byte[] ciphertext = base64(value.get("ct"), 2064), iv = base64(value.get("iv"), 12), clear = null;
    try {
      require(iv.length == 12 && ciphertext.length >= 16);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, entry.getSecretKey(), new GCMParameterSpec(128, iv));
      clear = cipher.doFinal(ciphertext);
      require(clear.length > 0 && clear.length <= 2048);
      for (byte item : clear) require(item >= 32 && item <= 126);
      String text = new String(clear, StandardCharsets.US_ASCII);
      JSONArray array = new JSONArray(text); require(array.toString().equals(text));
      return array;
    } finally {
      Arrays.fill(ciphertext, (byte) 0); Arrays.fill(iv, (byte) 0);
      if (clear != null) Arrays.fill(clear, (byte) 0);
    }
  }
  private static String text(Object value) {
    require(value instanceof String); return (String) value;
  }
  @Override public DeletionAuthority.Inventory read() {
    try {
      require(!preferences.contains(slot("stage")) && !preferences.contains("stage"));
      String encodedReceipt = encrypted("inventory");
      KeyStore keystore = KeyStore.getInstance("AndroidKeyStore"); keystore.load(null);
      KeyStore.Entry keyEntry = keystore.getEntry(ALIAS, null);
      require(keyEntry instanceof KeyStore.SecretKeyEntry);
      KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keyEntry;
      JSONArray receipt = plaintext(encodedReceipt, entry);
      require(receipt.length() == 6 && "HGI1".equals(receipt.get(0)) && integer(receipt.get(3)) == 1);
      String vault = text(receipt.get(1)), selected = text(receipt.get(4));
      long revision = integer(receipt.get(2));
      require(receipt.get(5) instanceof JSONArray);
      JSONArray identities = receipt.getJSONArray(5);
      require(identities.length() > 0 && identities.length() <= 16);
      Map<String, String> digests = new HashMap<>(), captured = new HashMap<>();
      for (int index = 0; index < identities.length(); index++) {
        JSONArray identity = identities.getJSONArray(index);
        require(identity.length() == 3 && integer(identity.get(2)) <= 1); integer(identity.get(1));
        String pubkey = text(identity.get(0)); require(DeletionAuthority.key(pubkey) && !digests.containsKey(pubkey));
        String encodedSecret = encrypted("secret." + pubkey);
        JSONArray secret = plaintext(encodedSecret, entry);
        require(secret.length() == 3 && "HGK1".equals(secret.get(0)) && pubkey.equals(secret.get(1)));
        String scalar = text(secret.get(2));
        require(DeletionAuthority.key(scalar) && !scalar.equals("0000000000000000000000000000000000000000000000000000000000000000") && scalar.compareTo(CURVE_ORDER) < 0);
        digests.put(pubkey, digest(encodedSecret)); captured.put("secret." + pubkey, encodedSecret);
      }
      require(encodedReceipt.equals(encrypted("inventory")));
      for (Map.Entry<String, String> record : captured.entrySet()) require(record.getValue().equals(encrypted(record.getKey())));
      require(!preferences.contains(slot("stage")) && !preferences.contains("stage"));
      return new DeletionAuthority.Inventory(vault, revision, selected, digest(encodedReceipt), digests);
    } catch (Exception ignored) { throw new DeletionAuthority.Denied(); }
  }
  /** Native backup effect only. The authority supplies the exact encrypted-record digest. */
  char[] backup(String pubkey, String expectedDigest) {
    byte[] scalarBytes = null;
    char[] result = null;
    try {
      require(DeletionAuthority.key(pubkey) && DeletionAuthority.key(expectedDigest));
      String key = "secret." + pubkey, encoded = encrypted(key);
      require(digest(encoded).equals(expectedDigest));
      KeyStore keystore = KeyStore.getInstance("AndroidKeyStore"); keystore.load(null);
      KeyStore.Entry entry = keystore.getEntry(ALIAS, null);
      require(entry instanceof KeyStore.SecretKeyEntry);
      JSONArray secret = plaintext(encoded, (KeyStore.SecretKeyEntry) entry);
      require(secret.length() == 3 && "HGK1".equals(secret.get(0)) && pubkey.equals(secret.get(1)));
      String scalar = text(secret.get(2));
      require(DeletionAuthority.key(scalar));
      scalarBytes = new byte[32];
      for (int index = 0; index < 32; index++) scalarBytes[index] = (byte) Integer.parseInt(scalar.substring(index * 2, index * 2 + 2), 16);
      result = BackupNsec.encode(scalarBytes);
      require(encoded.equals(encrypted(key)) && !preferences.contains(slot("stage")) && !preferences.contains("stage"));
      return result;
    } catch (Exception ignored) {
      if (result != null) Arrays.fill(result, '\0');
      throw new DeletionAuthority.Denied();
    } finally { if (scalarBytes != null) Arrays.fill(scalarBytes, (byte) 0); }
  }
  /** Only pass this native effect to DeletionAuthority.erase; never expose a generic remove method. */
  void erase(String pubkey) {
    try {
      require(DeletionAuthority.key(pubkey));
      String key = "secret." + pubkey;
      require(!preferences.contains(key));
      require(preferences.edit().remove(slot(key)).commit());
      require(!preferences.contains(slot(key)) && !preferences.contains(key));
    } catch (Exception ignored) { throw new DeletionAuthority.Denied(); }
  }
}
