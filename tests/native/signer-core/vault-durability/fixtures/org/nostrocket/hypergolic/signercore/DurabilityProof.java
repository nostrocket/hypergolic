package org.nostrocket.hypergolic.signercore;
import android.content.Context;
import android.util.AtomicFile;
import fixture.KeyStoreProvider;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

/**
 * Contract tests execute the whole unchanged-shape production NativeVaultFile read/write
 * orchestration.
 */
public final class DurabilityProof {
  static final byte[] OLD = {1, 2, 3}, NEXT = {4, 5, 6, 7};
  static String fault = "none";
  static int assertions, failures, cases;

  static void check(boolean ok, String name) {
    assertions++;
    if (!ok) {
      failures++;
      System.out.println("FAIL " + name);
    }
  }

  static NativeVaultFile storage(File directory) throws Exception {
    Context context = new Context() {
      public File getNoBackupFilesDir() {
        return directory;
      }
    };
    for (Constructor<?> c : NativeVaultFile.class.getDeclaredConstructors())
      if (c.getParameterCount() == 2) {
        Class<?> port = c.getParameterTypes()[1];
        Object sync =
            Proxy.newProxyInstance(port.getClassLoader(), new Class<?>[] {port}, (p, m, a) -> {
              if (m.getName().equals("syncFile")) {
                AtomicFile.events.add("checked-file-sync");
                if (fault.equals("file"))
                  throw new IOException("injected checked file sync");
                ((FileOutputStream) a[0]).getFD().sync();
              } else if (m.getName().equals("syncDirectory")) {
                File d = (File) a[0];
                String level = d.getName().equals("native-signer") ? "child" : "parent";
                AtomicFile.events.add("checked-dir-sync:" + level);
                if (fault.equals(level))
                  throw new IOException("injected checked directory sync");
              }
              return null;
            });
        c.setAccessible(true);
        return (NativeVaultFile) c.newInstance(context, sync);
      }
    return new NativeVaultFile(context);
  }

  static File fresh(String name) throws Exception {
    KeyStoreProvider.keys.clear();
    AtomicFile.reset();
    fault = "none";
    android.system.Os.failDirectory = null;
    android.system.Os.failCloseDirectory = null;
    android.system.Os.events.clear();
    android.system.Os.wrongType = false;
    return Files.createTempDirectory("vault-durability-" + name).toFile();
  }

  static boolean write(NativeVaultFile store) {
    try {
      store.write(NEXT, false);
      return true;
    } catch (NativeVault.Error expected) {
      return false;
    }
  }

  static void clear(File p) throws Exception {
    if (p.isDirectory())
      for (File f : Objects.requireNonNull(p.listFiles())) clear(f);
    Files.deleteIfExists(p.toPath());
  }

  static void normal() throws Exception {
    cases++;
    File root = fresh("normal");
    try {
      NativeVaultFile s = storage(root);
      s.write(OLD, true);
      check(Arrays.equals(s.read(), OLD), "initial actual AES readback");
      AtomicFile.reset();
      check(write(s), "successful replace acknowledged");
      check(AtomicFile.events.equals(List.of("start", "checked-file-sync", "finish",
                "checked-dir-sync:child", "checked-dir-sync:parent", "read")),
          "checked file and directory barriers precede success/readback");
      check(Arrays.equals(storage(root).read(), NEXT), "cold actual AES readback matches new data");
    } finally {
      clear(root);
    }
  }

  static void failure(String stage) throws Exception {
    cases++;
    File root = fresh(stage);
    try {
      NativeVaultFile s = storage(root);
      s.write(OLD, true);
      AtomicFile.reset();
      fault = stage;
      if (stage.equals("file"))
        AtomicFile.swallowSyncFailure = true;
      boolean acknowledged = write(s);
      check(!acknowledged, stage + " sync failure cannot acknowledge success");
      fault = "none";
      byte[] actual = storage(root).read();
      if (stage.equals("file")) {
        check(Arrays.equals(actual, OLD), "pre-commit file sync failure preserves previous bytes");
        check(AtomicFile.finishes == 0 && AtomicFile.failures == 1,
            "pre-commit failure uses AtomicFile failWrite, not finishWrite");
      } else {
        check(Arrays.equals(actual, NEXT),
            "post-commit sync failure remains error despite readable proposed bytes");
        check(AtomicFile.finishes == 1 && AtomicFile.failures == 0,
            "uncertain committed result is not rolled back or retried");
      }
      System.out.println("CASE " + stage + " acknowledged=" + acknowledged
          + " finishes=" + AtomicFile.finishes + " cleanup=" + AtomicFile.failures);
    } finally {
      clear(root);
    }
  }

  static void ordinaryFailure(String stage) throws Exception {
    cases++;
    File root = fresh(stage);
    try {
      NativeVaultFile s = storage(root);
      s.write(OLD, true);
      AtomicFile.reset();
      AtomicFile.failWrite = stage.equals("partial");
      AtomicFile.failRename = stage.equals("rename");
      AtomicFile.failRead = stage.equals("readback");
      check(!write(s), stage + " ordinary failure denied");
      AtomicFile.failRead = false;
      byte[] actual = storage(root).read();
      check(Arrays.equals(actual, stage.equals("readback") ? NEXT : OLD),
          stage + " explicit durable state after failed acknowledgement");
      if (stage.equals("partial"))
        check(AtomicFile.failures == 1 && AtomicFile.finishes == 0,
            "partial write aborts exact open stream");
    } finally {
      clear(root);
    }
  }

  static void interruptedInitial() throws Exception {
    cases++;
    File root = fresh("initial");
    try {
      NativeVaultFile s = storage(root);
      fault = "file";
      AtomicFile.swallowSyncFailure = true;
      boolean acknowledged;
      try {
        s.write(OLD, true);
        acknowledged = true;
      } catch (NativeVault.Error e) {
        acknowledged = false;
      }
      check(!acknowledged, "failed initial file sync cannot acknowledge identity creation");
      fault = "none";
      boolean denied = false;
      try {
        storage(root).read();
      } catch (NativeVault.Error e) {
        denied = true;
      }
      check(denied, "partial initial key state requires recovery and cannot become fresh absence");
    } finally {
      clear(root);
    }
  }

  static NativeVaultFile systemStorage(File root) {
    return new NativeVaultFile(new Context() {
      public File getNoBackupFilesDir() {
        return root;
      }
    });
  }

  static void systemAdapter(String failure) throws Exception {
    cases++;
    File root = fresh("adapter-" + failure);
    try {
      NativeVaultFile s = systemStorage(root);
      s.write(OLD, true);
      android.system.Os.events.clear();
      String directory = new File(root, "native-signer").getPath();
      if (failure.equals("sync"))
        android.system.Os.failDirectory = directory;
      if (failure.equals("close"))
        android.system.Os.failCloseDirectory = directory;
      if (failure.equals("type"))
        android.system.Os.wrongType = true;
      boolean ack = write(s);
      check(ack == failure.equals("none"),
          "fixed production constructor propagates directory " + failure);
      check(android.system.Os.events.contains("close-directory:" + directory),
          "actual system adapter closes directory after " + failure);
      android.system.Os.failDirectory = null;
      android.system.Os.failCloseDirectory = null;
      check(Arrays.equals(systemStorage(root).read(), NEXT),
          "adapter " + failure + " keeps committed proposed bytes for reconciliation");
    } finally {
      clear(root);
    }
  }

  public static void main(String[] args) throws Exception {
    Security.addProvider(new KeyStoreProvider());
    normal();
    for (String s : List.of("file", "child", "parent")) failure(s);
    for (String s : List.of("partial", "rename", "readback")) ordinaryFailure(s);
    interruptedInitial();
    for (String f : List.of("none", "sync", "close", "type")) systemAdapter(f);
    KeyStoreProvider.keys.clear();
    System.out.println("RESULT cases=" + cases + " assertions=" + assertions
        + " failures=" + failures
        + "; Android OS/Keystore/AtomicFile fault doubles; real host AES-GCM and temporary files; no Android hardware durability claim.");
    if (failures > 0)
      System.exit(1);
  }
}
