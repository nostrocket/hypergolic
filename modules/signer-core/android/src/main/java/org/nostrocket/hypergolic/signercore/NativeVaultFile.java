package org.nostrocket.hypergolic.signercore;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.system.Os;
import android.system.OsConstants;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Single app-private authenticated record. A missing key, malformed record or uncertain write never resets it. */
final class NativeVaultFile {
  static final int MAX_CLEAR_BYTES = 131072;
  private static final byte[] HEADER = {'H', 'G', 'S', 'V', 2};
  private static final String ALIAS = "org.nostrocket.hypergolic.native-signing-v2";
  private final AtomicFile file;
  private final KeyStore keystore;
  // Native-only fault seam; the production constructor always uses checked OS barriers.
  interface Durability {
    void syncFile(FileOutputStream stream) throws Exception;
    void syncDirectory(File directory) throws Exception;
  }
  private final Durability durability;
  private static final Durability SYSTEM_DURABILITY = new Durability() {
    public void syncFile(FileOutputStream stream) throws Exception { stream.getFD().sync(); }
    public void syncDirectory(File directory) throws Exception {
      FileDescriptor descriptor = Os.open(directory.getPath(),
        OsConstants.O_RDONLY | OsConstants.O_CLOEXEC | OsConstants.O_NOFOLLOW, 0);
      try {
        if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) throw new IOException("Not a directory");
        Os.fsync(descriptor);
      } finally { Os.close(descriptor); }
    }
  };

  NativeVaultFile(Context context) { this(context, SYSTEM_DURABILITY); }
  NativeVaultFile(Context context, Durability durability) {
    try {
      if (durability == null) throw new Exception();
      this.durability = durability;
      File directory = new File(context.getNoBackupFilesDir(), "native-signer");
      if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception();
      file = new AtomicFile(new File(directory, "vault.bin"));
      keystore = KeyStore.getInstance("AndroidKeyStore"); keystore.load(null);
    } catch (Exception failure) { throw new NativeVault.Error("STORAGE_FAILURE"); }
  }
  private boolean exists() {
    File base = file.getBaseFile();
    return base.exists() || new File(base.getPath()+".bak").exists() || new File(base.getPath()+".new").exists();
  }
  private SecretKey key(boolean create) throws Exception {
    if (keystore.containsAlias(ALIAS)) {
      KeyStore.Entry entry = keystore.getEntry(ALIAS, null);
      if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new Exception();
      return ((KeyStore.SecretKeyEntry)entry).getSecretKey();
    }
    if (!create || exists()) throw new Exception();
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    KeyGenParameterSpec.Builder parameters = new KeyGenParameterSpec.Builder(ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true);
    if (Build.VERSION.SDK_INT >= 28) parameters.setUnlockedDeviceRequired(true);
    generator.init(parameters.build()); return generator.generateKey();
  }
  synchronized byte[] read() {
    byte[] encoded = null;
    try {
      if (!exists()) {
        if (keystore.containsAlias(ALIAS)) throw new NativeVault.Error("RECOVERY_REQUIRED");
        return null;
      }
      try (java.io.FileInputStream input = file.openRead(); NativeSecretBuffer bytes = new NativeSecretBuffer(MAX_CLEAR_BYTES + 34)) {
        byte[] chunk = new byte[1024]; int count;
        while ((count=input.read(chunk)) != -1) {
          if (bytes.size()+count > HEADER.length+12+16+MAX_CLEAR_BYTES) throw new Exception();
          bytes.write(chunk,0,count);
        }
        encoded=bytes.toByteArray();
      }
      if (encoded.length < HEADER.length + 12 + 16 || encoded.length > HEADER.length + 12 + 16 + MAX_CLEAR_BYTES) throw new Exception();
      for (int i = 0; i < HEADER.length; i++) if (encoded[i] != HEADER[i]) throw new Exception();
      byte[] iv = Arrays.copyOfRange(encoded, HEADER.length, HEADER.length + 12);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv)); cipher.updateAAD(HEADER);
      byte[] clear = cipher.doFinal(encoded, HEADER.length + 12, encoded.length - HEADER.length - 12);
      if (clear.length == 0 || clear.length > MAX_CLEAR_BYTES) { Arrays.fill(clear, (byte)0); throw new Exception(); }
      return clear;
    } catch (NativeVault.Error error) { throw error; }
    catch (Exception failure) { throw new NativeVault.Error("CORRUPT_METADATA"); }
    finally { if (encoded != null) Arrays.fill(encoded, (byte)0); }
  }
  synchronized void write(byte[] clear, boolean initialize) {
    byte[] encrypted = null, encoded = null, readback = null;
    FileOutputStream stream = null;
    try {
      if (clear == null || clear.length == 0 || clear.length > MAX_CLEAR_BYTES || initialize == exists()) throw new Exception();
      if (initialize && keystore.containsAlias(ALIAS)) throw new NativeVault.Error("RECOVERY_REQUIRED");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key(initialize)); cipher.updateAAD(HEADER);
      byte[] iv = cipher.getIV(); if (iv.length != 12) throw new Exception();
      encrypted = cipher.doFinal(clear); encoded = new byte[HEADER.length + 12 + encrypted.length];
      System.arraycopy(HEADER, 0, encoded, 0, HEADER.length); System.arraycopy(iv, 0, encoded, HEADER.length, 12);
      System.arraycopy(encrypted, 0, encoded, HEADER.length + 12, encrypted.length);
      stream = file.startWrite(); stream.write(encoded);
      // AtomicFile's void finishWrite logs sync failures; establish a checked barrier first.
      durability.syncFile(stream);
      file.finishWrite(stream); stream = null;
      // Persist the replacement entry, and the native-signer directory when newly created.
      // A failure after finishWrite is uncertain: do not undo it or report success from readback.
      File directory = file.getBaseFile().getParentFile();
      durability.syncDirectory(directory);
      durability.syncDirectory(directory.getParentFile());
      readback = read();
      if (!Arrays.equals(clear, readback)) throw new NativeVault.Error("READBACK_FAILED");
    } catch (NativeVault.Error error) { if (stream != null) file.failWrite(stream); throw error; }
    catch (Exception failure) { if (stream != null) file.failWrite(stream); throw new NativeVault.Error("STORAGE_FAILURE"); }
    finally {
      if (encrypted != null) Arrays.fill(encrypted, (byte)0);
      if (encoded != null) Arrays.fill(encoded, (byte)0);
      if (readback != null) Arrays.fill(readback, (byte)0);
    }
  }
}
