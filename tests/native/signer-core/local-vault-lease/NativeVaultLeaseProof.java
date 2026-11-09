package org.nostrocket.hypergolic.signercore;

import android.content.Context;
import android.system.Os;
import android.util.AtomicFile;
import fixture.KeyStoreProvider;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Security;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.json.JSONObject;
import org.nostrocket.hypergolic.mesh.MeshAccountLeaseProof;

/** Actual NativeVault, native crypto and encrypted file. Android OS services are explicit host doubles. */
public final class NativeVaultLeaseProof {
  private static int assertions;
  private static void check(boolean value, String label) {
    if (!value) throw new AssertionError(label);
    assertions++;
  }
  private static void denied(Runnable effect, String label) {
    try {
      effect.run();
      throw new AssertionError(label);
    } catch (NativeVault.Error | IllegalStateException expected) {
      assertions++;
    }
  }
  private static String id(JSONObject record) { return record.getString("vaultId"); }
  private static long rev(JSONObject record) { return record.getLong("revision"); }
  private static String account(JSONObject record) { return record.getString("selectedPubkey"); }
  private static NativeSigningKey key(int index) {
    byte[] scalar = new byte[32];
    scalar[31] = (byte) index;
    try { return NativeSigningKey.importScalar(scalar); }
    finally { Arrays.fill(scalar, (byte) 0); }
  }
  private static void waitFor(CountDownLatch latch) {
    try { if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("race did not reach owner check"); }
    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
  }
  private static final class Owner implements AutoCloseable {
    final Object identity = new Object();
    final Context context;
    final NativeVault vault;
    final NativeVaultSession session = new NativeVaultSession();
    final AtomicBoolean available = new AtomicBoolean(true);
    final AtomicLong clock = new AtomicLong(1_000);
    final Supplier<NativeLocalVaultLease> provider = this::capture;
    Owner(Path dir) {
      context = new Context() { public File getNoBackupFilesDir() { return dir.toFile(); } };
      vault = new NativeVault(identity, context, clock::get);
    }
    NativeLocalVaultLease capture() {
      synchronized (session.lock) {
        long epoch = session.epoch;
        session.require(epoch, available::get);
        return vault.localLease(identity, epoch, () -> session.localLeaseCurrent(epoch, available::get));
      }
    }
    JSONObject open() { return new JSONObject(vault.open(identity)); }
    @Override public void close() {
      synchronized (session.lock) { session.invalidate(true); vault.close(); }
    }
  }
  private static void verify(NativeLocalVaultLease lease, JSONObject record, long epoch) {
    check(lease.isCurrent() && lease.account.equals(account(record)) && lease.vaultId.equals(id(record)) &&
      lease.vaultRevision == rev(record) && lease.runtimeEpoch == epoch, "exact persisted local owner metadata");
  }
  private static void stale(NativeLocalVaultLease lease, BooleanSupplier adapted, String operation) {
    check(!lease.isCurrent() && !adapted.getAsBoolean(), operation + " retired both source and adapted lease");
    MeshAccountLeaseProof.rejects(lease);
  }
  private static void selectionAndLifecycle(Path dir) throws Exception {
    try (Owner owner = new Owner(dir)) {
      denied(owner::capture, "unactivated owner minted");
      owner.session.activate(owner.available::get);
      denied(owner::capture, "uninitialized owner minted");
      JSONObject first = owner.open();
      String a = account(first), vault = id(first);
      long epoch = owner.session.epoch;
      NativeLocalVaultLease.install(owner.provider);
      denied(() -> NativeLocalVaultLease.install(() -> null), "foreign provider replaced owner");
      denied(() -> owner.vault.localLease(new Object(), epoch, () -> true), "foreign owner minted");
      var firstLease = NativeLocalVaultLease.capture();
      verify(firstLease, first, epoch);
      var firstMesh = MeshAccountLeaseProof.adapt(firstLease);
      owner.session.suspendLocalLeases(owner.vault);
      denied(owner::capture, "metadata captured during preserved-epoch pause");
      owner.session.resumeLocalLeases();
      check(owner.session.epoch == epoch, "preserved signer handoff keeps real signer epoch");
      stale(firstLease, firstMesh, "unobserved preserved-epoch pause and resume");
      var staleRevision = owner.capture();
      var staleRevisionMesh = MeshAccountLeaseProof.adapt(staleRevision);
      denied(() -> owner.vault.select(owner.identity, a, vault, rev(first) + 1), "wrong expected revision changed vault");
      stale(staleRevision, staleRevisionMesh, "rejected stale mutation");
      String b;
      try (var candidate = key(7)) { b = candidate.publicKey(); }
      var beforeAdd = owner.capture();
      var beforeAddMesh = MeshAccountLeaseProof.adapt(beforeAdd);
      var publicOnly = new JSONObject(owner.vault.addPublicIdentity(owner.identity, b, vault, rev(first)));
      check(account(publicOnly).equals(b), "public-only positive selection control");
      denied(owner::capture, "public-only identity minted");
      var restored = new JSONObject(owner.vault.select(owner.identity, a, vault, rev(publicOnly)));
      stale(beforeAdd, beforeAddMesh, "selection A to public B to A");
      verify(owner.capture(), restored, epoch);

      var beforeRemote = owner.capture();
      var beforeRemoteMesh = MeshAccountLeaseProof.adapt(beforeRemote);
      var remote = new NativeRemoteBinding(new NativeSigningKey(), b, List.of("wss://relay.example.org"));
      String handle = new JSONObject(owner.vault.prepareRemote(owner.identity, a, remote, 2_000, vault, rev(restored))).getString("handle");
      check(owner.vault.remoteActive(owner.identity, handle, vault, rev(restored)), "connection review is current");
      check(!owner.vault.refreshActive(owner.identity, handle, vault, rev(restored)), "connection cannot serve as refresh review");
      check(owner.vault.remoteReview(owner.identity, handle, vault, rev(restored)).contains(b), "connection review binds exact signer peer");
      var remoteSelected = new JSONObject(owner.vault.commitRemote(owner.identity, handle, vault, rev(restored)));
      var methods = new JSONObject(owner.vault.methods(owner.identity, a, vault, rev(remoteSelected)));
      check(methods.getString("selectedMethod").equals("nip46") && methods.getJSONArray("methods").length() == 2,
        "NIP-46 selected with a retained local key");
      denied(owner::capture, "retained local key bypassed selected NIP-46");
      var local = new JSONObject(owner.vault.selectMethod(owner.identity, a, "local", vault, rev(remoteSelected)));
      stale(beforeRemote, beforeRemoteMesh, "local to remote to local");
      var beforeRefresh = owner.capture();
      var beforeRefreshMesh = MeshAccountLeaseProof.adapt(beforeRefresh);
      try (var saved = owner.vault.savedRemote(owner.identity, a, vault, rev(local))) {
        var refresh = new NativeRemoteBinding(saved.client.copy(), saved.peer, List.of("wss://relay2.example.org"));
        String refreshHandle = new JSONObject(owner.vault.prepareRefresh(owner.identity, a, refresh, 2_000, vault, rev(local))).getString("handle");
        long reviewed = rev(local);
        denied(() -> owner.vault.cancelRemote(owner.identity, refreshHandle), "connection cancel consumed refresh");
        check(owner.vault.refreshActive(owner.identity, refreshHandle, vault, reviewed), "wrong-lane cancel preserves refresh");
        check(owner.vault.refreshReview(owner.identity, refreshHandle, vault, reviewed).contains("wss://relay2.example.org"),
          "refresh review binds exact relays");
        local = new JSONObject(owner.vault.commitRefresh(owner.identity, refreshHandle, vault, reviewed));
      }
      stale(beforeRefresh, beforeRefreshMesh, "remote refresh with local backend preserved");
      var beforeAndroid = owner.capture();
      var beforeAndroidMesh = MeshAccountLeaseProof.adapt(beforeAndroid);
      var signer = new NativeAndroidSignerBinding("org.example.disposable.signer", List.of("01".repeat(32)));
      String android = new JSONObject(owner.vault.prepareAndroidSigner(owner.identity, a, signer, 2_000, vault, rev(local))).getString("handle");
      var androidSelected = new JSONObject(owner.vault.commitAndroidSigner(owner.identity, android, vault, rev(local)));
      denied(owner::capture, "retained local key bypassed selected Android signer");
      local = new JSONObject(owner.vault.selectMethod(owner.identity, a, "local", vault, rev(androidSelected)));
      stale(beforeAndroid, beforeAndroidMesh, "Android signer commit and local restoration");

      var beforeImport = owner.capture();
      var beforeImportMesh = MeshAccountLeaseProof.adapt(beforeImport);
      String importHandle = new JSONObject(owner.vault.prepareImport(owner.identity, key(7), vault, rev(local))).getString("handle");
      var imported = new JSONObject(owner.vault.commitImport(owner.identity, importHandle, vault, rev(local)));
      stale(beforeImport, beforeImportMesh, "local import selected another account");
      var importedLease = owner.capture();
      var importedMesh = MeshAccountLeaseProof.adapt(importedLease);
      owner.vault.deleteLocal(owner.identity, b, vault, rev(imported));
      denied(owner::capture, "identity with removed local key minted");
      stale(importedLease, importedMesh, "selected local key deletion");
      var back = new JSONObject(owner.vault.select(owner.identity, a, vault, rev(imported) + 1));
      var beforeDelete = owner.capture();
      var beforeDeleteMesh = MeshAccountLeaseProof.adapt(beforeDelete);
      owner.vault.delete(owner.identity, b, vault, rev(back));
      stale(beforeDelete, beforeDeleteMesh, "nonselected identity deletion changes real vault revision");
      var beforeClose = owner.capture();
      var beforeCloseMesh = MeshAccountLeaseProof.adapt(beforeClose);
      owner.vault.close();
      stale(beforeClose, beforeCloseMesh, "close");
      owner.open();
      var beforeRetire = owner.capture();
      var beforeRetireMesh = MeshAccountLeaseProof.adapt(beforeRetire);
      owner.available.set(false);
      owner.session.invalidate(true);
      denied(owner::capture, "retired owner minted");
      stale(beforeRetire, beforeRetireMesh, "owner retirement");
    }
  }
  private static void candidateExpiry(Path dir) {
    try (Owner owner = new Owner(dir); var peer = key(7)) {
      owner.session.activate(owner.available::get);
      var first = owner.open();
      var binding = new NativeRemoteBinding(new NativeSigningKey(), peer.publicKey(), List.of("wss://relay.example.org"));
      String handle = new JSONObject(owner.vault.prepareRemote(owner.identity, account(first), binding, 2_000,
        id(first), rev(first))).getString("handle");
      owner.clock.set(2_000);
      check(!owner.vault.remoteActive(owner.identity, handle, id(first), rev(first)), "candidate expires at original deadline");
      denied(() -> owner.vault.commitRemote(owner.identity, handle, id(first), rev(first)), "expired candidate committed");
      check(rev(owner.open()) == rev(first), "expiry preserves persisted record");
    }
  }
  private static void checkRace(Path dir) throws Exception {
    try (Owner owner = new Owner(dir)) {
      owner.session.activate(owner.available::get);
      var first = owner.open();
      var gate = new AtomicBoolean();
      var entered = new CountDownLatch(1);
      var resume = new CountDownLatch(1);
      var stale = owner.vault.localLease(owner.identity, owner.session.epoch, () -> {
        if (gate.compareAndSet(true, false)) { entered.countDown(); waitFor(resume); }
        return true;
      });
      gate.set(true);
      var worker = Executors.newSingleThreadExecutor();
      try {
        var oldCheck = worker.submit(stale::isCurrent);
        waitFor(entered);
        // Change the persisted revision while the stale check is between runtime and vault checks.
        String b;
        try (var disposable = key(7)) { b = disposable.publicKey(); }
        var added = new JSONObject(owner.vault.addPublicIdentity(owner.identity, b, id(first), rev(first)));
        owner.vault.select(owner.identity, account(first), id(first), rev(added));
        var fresh = owner.capture();
        var freshMesh = MeshAccountLeaseProof.adapt(fresh);
        resume.countDown();
        check(!oldCheck.get(5, TimeUnit.SECONDS) && freshMesh.getAsBoolean(), "stale in-flight check cannot consume fresh brand");
      } finally {
        resume.countDown();
        worker.shutdownNow();
      }
    }
  }
  private static void writeFailure(Path dir, boolean uncertain) throws Exception {
    try (Owner owner = new Owner(dir)) {
      owner.session.activate(owner.available::get);
      var first = owner.open();
      var prior = owner.capture();
      var adapted = MeshAccountLeaseProof.adapt(prior);
      String b;
      try (var disposable = key(9)) { b = disposable.publicKey(); }
      if (uncertain) Os.failDirectory = dir.resolve("native-signer").toString();
      else AtomicFile.failWrite = true;
      try { denied(() -> owner.vault.addPublicIdentity(owner.identity, b, id(first), rev(first)), "fault reported success"); }
      finally { Os.failDirectory = null; AtomicFile.reset(); }
      stale(prior, adapted, "failed or uncertain write");
      denied(owner::capture, "poisoned vault reissued lease");
      try (Owner cold = new Owner(dir)) {
        var persisted = cold.open();
        check(rev(persisted) == rev(first) + (uncertain ? 1 : 0), "cold owner shows actual durable outcome");
      }
    }
  }
  private static void boundsAndCorruption(Path dir) throws Exception {
    try (Owner owner = new Owner(dir)) {
      owner.session.activate(owner.available::get);
      var record = owner.open();
      var first = owner.capture();
      for (int i = 1; i < 16; i++) verify(owner.capture(), record, owner.session.epoch);
      denied(owner::capture, "seventeenth live lease accepted");
      var typed = MeshAccountLeaseProof.adapt(first);
      var file = dir.resolve("native-signer/vault.bin");
      byte[] damaged = Files.readAllBytes(file);
      damaged[damaged.length - 1] ^= 1;
      Files.write(file, damaged);
      stale(first, typed, "failed authenticated readback");
      denied(owner::capture, "corrupt persisted vault minted");
    }
  }
  public static void main(String[] args) throws Exception {
    Security.addProvider(new KeyStoreProvider());
    denied(NativeLocalVaultLease::capture, "uninstalled provider minted");
    MeshAccountLeaseProof.rejects(null);
    Path root = Path.of(args[0]);
    selectionAndLifecycle(Files.createDirectory(root.resolve("selection")));
    KeyStoreProvider.keys.clear();
    candidateExpiry(Files.createDirectory(root.resolve("expiry")));
    KeyStoreProvider.keys.clear();
    checkRace(Files.createDirectory(root.resolve("race")));
    KeyStoreProvider.keys.clear();
    writeFailure(Files.createDirectory(root.resolve("failure")), false);
    KeyStoreProvider.keys.clear();
    writeFailure(Files.createDirectory(root.resolve("uncertain")), true);
    KeyStoreProvider.keys.clear();
    boundsAndCorruption(Files.createDirectory(root.resolve("bounds")));
    System.out.println("NATIVE_LOCAL_VAULT_ASSERTIONS=" + assertions);
  }
}
