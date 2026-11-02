package org.nostrocket.hypergolic.signercore;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.Arrays;
import org.json.JSONObject;
import org.nostrocket.hypergolic.identityowner.NativeKeyEncoding;

/** Owning Android vault/Keystore/JNI proof in an explicitly disposable package. Not a production bridge. */
public final class VaultProofActivity extends Activity {
  private static final String PACKAGE = "org.nostrocket.hypergolic.signercore.vaultproof";
  private static final String ALIAS = "org.nostrocket.hypergolic.native-signing-v2";
  private final Object owner = new Object();
  private int assertions;
  private NativeVault vault;
  private NativeSignerCore reviewCore;
  private final NativeReviewPanel panel = new NativeReviewPanel();
  private JSONObject publicEvent;

  private void check(boolean accepted) { assertions++; if (!accepted) throw new AssertionError("Native vault assertion " + assertions); }
  private void denied(Runnable action) {
    assertions++;
    try { action.run(); } catch (RuntimeException expected) { return; }
    throw new AssertionError("Expected native vault denial " + assertions);
  }
  private JSONObject json(String value) {
    try { return new JSONObject(value); } catch (Exception failure) { throw new AssertionError(failure); }
  }
  private void write(String name, JSONObject value) throws Exception {
    File temporary = new File(getFilesDir(), name + ".tmp");
    Files.write(temporary.toPath(), value.toString().getBytes(StandardCharsets.UTF_8));
    if (!temporary.renameTo(new File(getFilesDir(), name))) throw new Exception("Proof receipt unavailable");
  }
  private File file() { return new File(getNoBackupFilesDir(), "native-signer/vault.bin"); }
  private void resetFixture() throws Exception {
    if (!PACKAGE.equals(getPackageName())) throw new Exception("Disposable package required");
    if (vault != null) { vault.close(); vault = null; }
    for (String suffix : new String[]{"", ".bak", ".new"}) {
      File path = new File(file().getPath() + suffix);
      if (path.exists() && !path.delete()) throw new Exception("Disposable fixture cleanup failed");
    }
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); keys.deleteEntry(ALIAS);
  }
  private JSONObject snapshot() { return json(vault.publicSnapshot(owner)); }
  private String id(JSONObject value) { return value.optString("vaultId"); }
  private long revision(JSONObject value) { return value.optLong("revision"); }
  private JSONObject prepare(int scalar, JSONObject state) {
    byte[] raw = new byte[32]; raw[31] = (byte)scalar;
    NativeSigningKey key = null;
    try {
      key = NativeSigningKey.importScalar(raw);
      JSONObject prepared = json(vault.prepareImport(owner, key, id(state), revision(state)));
      key = null;
      return prepared;
    } finally { Arrays.fill(raw, (byte)0); if (key != null) key.close(); }
  }
  private JSONObject commit(JSONObject prepared, JSONObject state) {
    return json(vault.commitImport(owner, prepared.optString("handle"), id(state), revision(state)));
  }
  private void codecCases() {
    byte[] scalar = new byte[32]; scalar[31] = 3;
    char[] nsec = NativeKeyEncoding.encode(scalar); byte[] decoded = null;
    try {
      check(Arrays.equals(nsec, "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re".toCharArray()));
      decoded = NativeKeyEncoding.decode(nsec); check(Arrays.equals(scalar, decoded)); Arrays.fill(decoded, (byte)0);
      char[] upper = nsec.clone(); for (int i = 0; i < upper.length; i++) upper[i] = Character.toUpperCase(upper[i]);
      try { decoded = NativeKeyEncoding.decode(upper); check(Arrays.equals(scalar, decoded)); } finally { Arrays.fill(upper, '\0'); if (decoded != null) Arrays.fill(decoded, (byte)0); }
      char[] mixed = nsec.clone(); mixed[0] = 'N'; denied(() -> NativeKeyEncoding.decode(mixed)); Arrays.fill(mixed, '\0');
      char[] changed = nsec.clone(); changed[62] = changed[62] == 'q' ? 'p' : 'q'; denied(() -> NativeKeyEncoding.decode(changed)); Arrays.fill(changed, '\0');
      denied(() -> NativeKeyEncoding.decode("npub1".toCharArray()));
      denied(() -> NativeKeyEncoding.encode(new byte[32]));
    } finally { Arrays.fill(scalar, (byte)0); Arrays.fill(nsec, '\0'); if (decoded != null) Arrays.fill(decoded, (byte)0); }
  }
  private void fresh() throws Exception {
    check(!file().exists()); vault = new NativeVault(owner, this);
    JSONObject value = json(vault.open(owner));
    check(value.optLong("revision") == 1); check(value.getJSONArray("identities").length() == 1);
    check(value.getJSONArray("identities").getJSONObject(0).getString("origin").equals("generated"));
    check(value.optString("selectedPubkey").matches("[a-f0-9]{64}"));
    denied(() -> vault.publicSnapshot(new Object()));
    byte[] cipher = Files.readAllBytes(file().toPath()); check(cipher.length > 64); check(cipher[0] == 'H' && cipher[4] == 2);
    write("restart.json", value); vault.close();
    write("fresh.json", new JSONObject().put("status", "passed").put("assertions", assertions).put("snapshot", value));
    ((TextView)findViewById(android.R.id.text1)).setText("Fresh encrypted vault written. Cold restart required.");
  }
  private void inventoryCases(long[] clock) throws Exception {
    JSONObject initial = snapshot(); String generated = initial.getString("selectedPubkey");
    JSONObject cancelled = prepare(3, initial); vault.cancelImport(owner, cancelled.getString("handle"));
    denied(() -> vault.commitImport(owner, cancelled.optString("handle"), id(initial), revision(initial)));
    check(snapshot().toString().equals(initial.toString()));
    JSONObject candidate = prepare(3, initial);
    denied(() -> vault.commitImport(new Object(), candidate.optString("handle"), id(initial), revision(initial)));
    denied(() -> vault.commitImport(owner, candidate.optString("handle"), id(initial), revision(initial) + 1));
    check(vault.importActive(owner, candidate.getString("handle"), id(initial), revision(initial)));
    JSONObject imported = commit(candidate, initial); String importedKey = imported.getString("selectedPubkey");
    check(importedKey.equals("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"));
    check(imported.getJSONArray("identities").length() == 2); check(imported.getLong("revision") == 2);
    JSONObject firstImported = imported.getJSONArray("identities").getJSONObject(1);
    JSONObject duplicate = commit(prepare(3, imported), imported);
    check(duplicate.toString().equals(imported.toString()));
    JSONObject selected = json(vault.select(owner, generated, id(imported), revision(imported)));
    check(selected.getLong("revision") == 3); check(selected.getString("selectedPubkey").equals(generated));
    JSONObject existingInactive = commit(prepare(3, selected), selected);
    check(existingInactive.getLong("revision") == 4); check(existingInactive.getJSONArray("identities").getJSONObject(1).toString().equals(firstImported.toString()));
    JSONObject current = existingInactive;
    for (int scalar = 4; scalar <= 17; scalar++) current = commit(prepare(scalar, current), current);
    check(current.getJSONArray("identities").length() == NativeVault.MAX_IDENTITIES);
    JSONObject full = current;
    denied(() -> prepare(18, full)); check(snapshot().toString().equals(full.toString()));
    JSONObject fullExisting = commit(prepare(3, full), full);
    check(fullExisting.getJSONArray("identities").length() == 16); check(fullExisting.getString("selectedPubkey").equals(importedKey));
    check(fullExisting.getJSONArray("identities").getJSONObject(1).toString().equals(firstImported.toString()));
    JSONObject fullCurrent = commit(prepare(3, fullExisting), fullExisting); check(fullCurrent.toString().equals(fullExisting.toString()));
    byte[] retained = vault.backupScalar(owner, importedKey, id(fullCurrent), revision(fullCurrent));
    try { check(retained.length == 32 && retained[31] == 3); for (int i = 0; i < 31; i++) check(retained[i] == 0); }
    finally { Arrays.fill(retained, (byte)0); }
    denied(() -> vault.delete(owner, importedKey, id(fullCurrent), revision(fullCurrent)));
    JSONObject expired = prepare(3, fullCurrent); clock[0] += 120_000;
    check(!vault.importActive(owner, expired.getString("handle"), id(fullCurrent), revision(fullCurrent)));
    denied(() -> vault.commitImport(owner, expired.optString("handle"), id(fullCurrent), revision(fullCurrent)));
    JSONObject next = prepare(3, fullCurrent); vault.cancelImport(owner, expired.getString("handle"));
    check(vault.importActive(owner, next.getString("handle"), id(fullCurrent), revision(fullCurrent)));
    clock[0] += 120_000;
    denied(() -> vault.commitImport(owner, next.optString("handle"), id(fullCurrent), revision(fullCurrent)));
    JSONObject afterExpired = prepare(3, fullCurrent); vault.cancelImport(owner, afterExpired.getString("handle"));
    check(snapshot().toString().equals(fullCurrent.toString()));
    JSONObject background = prepare(3, fullCurrent); vault.close();
    check(!vault.importActive(owner, background.getString("handle"), id(fullCurrent), revision(fullCurrent)));
    check(json(vault.open(owner)).toString().equals(fullCurrent.toString()));
    vault.delete(owner, generated, id(fullCurrent), revision(fullCurrent));
    JSONObject deleted = snapshot(); check(deleted.getJSONArray("identities").length() == 15); check(deleted.getLong("revision") == revision(fullCurrent) + 1);
  }
  private void replyCancellationCases() throws Exception {
    for (String lane : new String[]{"import", "select", "delete"}) {
      resetFixture();
      vault = new NativeVault(owner, this);
      JSONObject first = json(vault.open(owner));
      JSONObject second = commit(prepare(3, first), first);
      JSONObject third = commit(prepare(4, second), second);
      NativeVaultSession session = new NativeVaultSession(); session.activate(() -> true);
      long admitted = session.beginAction(() -> true);
      NativeMutationReceipt receipt = new NativeMutationReceipt(vault);
      String removed = first.getString("selectedPubkey");
      if (lane.equals("import")) commit(prepare(5, third), third);
      else if (lane.equals("select")) vault.select(owner, removed, id(third), revision(third));
      else vault.delete(owner, removed, id(third), revision(third));
      session.invalidate(false);
      RuntimeException replyFailure = null;
      try { synchronized (session.lock) { session.require(admitted, () -> true); } }
      catch (Exception cancelled) { replyFailure = receipt.failure(cancelled); }
      check(replyFailure instanceof NativeVault.Error && ((NativeVault.Error)replyFailure).code.equals("READBACK_FAILED"));
      vault.close(); vault = new NativeVault(owner, this);
      JSONObject durable = json(vault.open(owner));
      check(durable.getLong("revision") == third.getLong("revision") + 1);
      if (lane.equals("delete")) check(durable.getJSONArray("identities").length() == 2);
      else if (lane.equals("select")) check(durable.getString("selectedPubkey").equals(removed));
      else check(durable.getJSONArray("identities").length() == 4);
      NativeMutationReceipt beforeEffect = new NativeMutationReceipt(vault);
      check(((NativeVault.Error)beforeEffect.failure(new NativeVault.Error("AUTHORIZATION_DENIED"))).code.equals("AUTHORIZATION_DENIED"));
    }
  }

  private NativeRemoteBinding binding(String peer) {
    return new NativeRemoteBinding(new NativeSigningKey(), peer, java.util.List.of("wss://relay.example.org"));
  }
  private void methodCases() throws Exception {
    resetFixture();
    long[] clock = {100};
    vault = new NativeVault(owner, this, () -> clock[0]);
    JSONObject initial = json(vault.open(owner));
    byte[] scalar = new byte[32]; scalar[31] = 9;
    String user;
    try (NativeSigningKey key = NativeSigningKey.importScalar(scalar)) { user = key.publicKey(); }
    finally { Arrays.fill(scalar, (byte)0); }
    scalar[31] = 7;
    String peer;
    try (NativeSigningKey key = NativeSigningKey.importScalar(scalar)) { peer = key.publicKey(); }
    finally { Arrays.fill(scalar, (byte)0); }
    NativeRemoteBinding remote = binding(peer);
    String client = remote.client.publicKey();
    JSONObject prepared = json(vault.prepareRemote(owner, user, remote, clock[0] + 120_000, id(initial), revision(initial)));
    denied(() -> vault.commitRemote(new Object(), prepared.optString("handle"), id(initial), revision(initial)));
    check(vault.remoteActive(owner, prepared.getString("handle"), id(initial), revision(initial)));
    JSONObject connected = json(vault.commitRemote(owner, prepared.getString("handle"), id(initial), revision(initial)));
    check(connected.getJSONArray("identities").length() == 2);
    check(connected.getJSONArray("identities").getJSONObject(1).getString("origin").equals("connected"));
    JSONObject remoteMetadata = json(vault.methods(owner, user, id(connected), revision(connected)));
    check(remoteMetadata.getString("selectedMethod").equals("nip46"));
    check(remoteMetadata.getJSONArray("methods").length() == 1);
    denied(() -> vault.signingKey(owner, user, id(connected), revision(connected)));
    denied(() -> vault.backupScalar(owner, user, id(connected), revision(connected)));
    vault.close();
    check(json(vault.open(owner)).toString().equals(connected.toString()));
    try (NativeRemoteBinding read = vault.remoteSigning(owner, user, id(connected), revision(connected))) {
      check(read.client.publicKey().equals(client));
      check(read.peer.equals(peer));
    }
    NativeRemoteBinding duplicate = binding(peer);
    try { denied(() -> vault.prepareRemote(owner, user, duplicate, clock[0] + 120_000, id(connected), revision(connected))); }
    finally { duplicate.close(); }
    JSONObject localCandidate = prepare(9, connected);
    check(json(vault.methods(owner, user, id(connected), revision(connected))).getString("selectedMethod").equals("nip46"));
    check(vault.importActive(owner, localCandidate.getString("handle"), id(connected), revision(connected)));
    JSONObject local = commit(localCandidate, connected);
    check(local.getJSONArray("identities").length() == 2);
    check(local.getJSONArray("identities").getJSONObject(1).toString().equals(connected.getJSONArray("identities").getJSONObject(1).toString()));
    JSONObject linked = json(vault.methods(owner, user, id(local), revision(local)));
    check(linked.getString("selectedMethod").equals("local"));
    check(linked.getJSONArray("methods").length() == 2);
    check(json(vault.selectMethod(owner, user, "local", id(local), revision(local))).toString().equals(local.toString()));
    JSONObject external = json(vault.selectMethod(owner, user, "nip46", id(local), revision(local)));
    byte[] backup = vault.backupScalar(owner, user, id(external), revision(external));
    try { check(backup[31] == 9); } finally { Arrays.fill(backup, (byte)0); }
    vault.deleteLocal(owner, user, id(external), revision(external));
    JSONObject remoteOnly = snapshot();
    check(json(vault.methods(owner, user, id(remoteOnly), revision(remoteOnly))).getString("selectedMethod").equals("nip46"));
    JSONObject disconnected = json(vault.disconnect(owner, user, "nip46", id(remoteOnly), revision(remoteOnly)));
    JSONObject empty = json(vault.methods(owner, user, id(disconnected), revision(disconnected)));
    check(empty.isNull("selectedMethod"));
    check(empty.getJSONArray("methods").length() == 0);
    check(disconnected.getJSONArray("identities").length() == 2);
    denied(() -> vault.signingKey(owner, user, id(disconnected), revision(disconnected)));
    JSONObject restored = commit(prepare(9, disconnected), disconnected);
    vault.deleteLocal(owner, user, id(restored), revision(restored));
    JSONObject noLocal = snapshot();
    check(json(vault.methods(owner, user, id(noLocal), revision(noLocal))).isNull("selectedMethod"));
    NativeRemoteBinding expiring = binding(peer);
    JSONObject candidate = json(vault.prepareRemote(owner, user, expiring, clock[0] + 120_000, id(noLocal), revision(noLocal)));
    clock[0] += 120_000;
    check(!vault.remoteActive(owner, candidate.getString("handle"), id(noLocal), revision(noLocal)));
    denied(() -> expiring.client.publicKey());
    check(snapshot().toString().equals(noLocal.toString()));
    NativeRemoteBinding cancelled = binding(peer);
    JSONObject cancelledHandle = json(vault.prepareRemote(owner, user, cancelled, clock[0] + 120_000, id(noLocal), revision(noLocal)));
    vault.cancelRemote(owner, cancelledHandle.getString("handle"));
    denied(() -> cancelled.client.publicKey());
    check(snapshot().toString().equals(noLocal.toString()));
    resetFixture();
  }
  private void methodReplyCancellationCases() throws Exception {
    byte[] scalar = new byte[32]; scalar[31] = 7;
    String peer;
    try (NativeSigningKey key = NativeSigningKey.importScalar(scalar)) { peer = key.publicKey(); }
    finally { Arrays.fill(scalar, (byte)0); }
    for (String lane : new String[]{"connect", "method", "disconnect", "local-delete"}) {
      resetFixture();
      vault = new NativeVault(owner, this);
      JSONObject first = json(vault.open(owner));
      String user = first.getString("selectedPubkey");
      NativeRemoteBinding capability = binding(peer);
      JSONObject prepared = json(vault.prepareRemote(owner, user, capability, android.os.SystemClock.elapsedRealtime() + 120_000,
        id(first), revision(first)));
      JSONObject before = first;
      NativeMutationReceipt receipt;
      if (!lane.equals("connect")) {
        before = json(vault.commitRemote(owner, prepared.getString("handle"), id(first), revision(first)));
      }
      NativeVaultSession session = new NativeVaultSession(); session.activate(() -> true);
      long admitted = session.beginAction(() -> true);
      receipt = new NativeMutationReceipt(vault);
      if (lane.equals("connect")) vault.commitRemote(owner, prepared.getString("handle"), id(before), revision(before));
      else if (lane.equals("method")) vault.selectMethod(owner, user, "local", id(before), revision(before));
      else if (lane.equals("disconnect")) vault.disconnect(owner, user, "nip46", id(before), revision(before));
      else vault.deleteLocal(owner, user, id(before), revision(before));
      session.invalidate(false);
      RuntimeException reply = null;
      try { synchronized (session.lock) { session.require(admitted, () -> true); } }
      catch (Exception cancelled) { reply = receipt.failure(cancelled); }
      check(reply instanceof NativeVault.Error && ((NativeVault.Error)reply).code.equals("READBACK_FAILED"));
      vault.close(); vault = new NativeVault(owner, this);
      JSONObject cold = json(vault.open(owner));
      check(cold.getLong("revision") == before.getLong("revision") + 1);
      check(cold.getString("selectedPubkey").equals(user));
      JSONObject methods = json(vault.methods(owner, user, id(cold), revision(cold)));
      if (lane.equals("method")) check(methods.getString("selectedMethod").equals("local"));
      else if (lane.equals("disconnect")) check(methods.isNull("selectedMethod") && methods.getJSONArray("methods").length() == 1);
      else check(methods.getString("selectedMethod").equals("nip46"));
      NativeMutationReceipt noEffect = new NativeMutationReceipt(vault);
      check(((NativeVault.Error)noEffect.failure(new NativeVault.Error("AUTHORIZATION_DENIED"))).code.equals("AUTHORIZATION_DENIED"));
    }
  }

  private NativeRemoteBinding changed(NativeRemoteBinding saved) {
    return new NativeRemoteBinding(saved.client.copy(), saved.peer, java.util.List.of("wss://relay2.example.org"));
  }
  private void refreshCases() throws Exception {
    resetFixture();
    long[] clock = {100};
    vault = new NativeVault(owner, this, () -> clock[0]);
    JSONObject initial = json(vault.open(owner));
    String user = initial.getString("selectedPubkey");
    byte[] scalar = new byte[32]; scalar[31] = 7;
    String peer;
    try (NativeSigningKey key = NativeSigningKey.importScalar(scalar)) { peer = key.publicKey(); }
    finally { Arrays.fill(scalar, (byte)0); }
    NativeRemoteBinding first = binding(peer);
    String client = first.client.publicKey();
    JSONObject connection = json(vault.prepareRemote(owner, user, first, clock[0] + 120_000, id(initial), revision(initial)));
    denied(() -> vault.commitRefresh(owner, connection.optString("handle"), id(initial), revision(initial)));
    check(vault.remoteActive(owner, connection.getString("handle"), id(initial), revision(initial)));
    JSONObject connected = json(vault.commitRemote(owner, connection.getString("handle"), id(initial), revision(initial)));
    JSONObject local = json(vault.selectMethod(owner, user, "local", id(connected), revision(connected)));
    try (NativeRemoteBinding saved = vault.savedRemote(owner, user, id(local), revision(local))) {
      check(saved.client.publicKey().equals(client));
      NativeRemoteBinding foreign = binding(peer);
      try { denied(() -> vault.prepareRefresh(owner, user, foreign, clock[0] + 120_000, id(local), revision(local))); }
      finally { foreign.close(); }
      NativeRemoteBinding cancelled = changed(saved);
      JSONObject candidate = json(vault.prepareRefresh(owner, user, cancelled, clock[0] + 120_000, id(local), revision(local)));
      denied(() -> vault.commitRemote(owner, candidate.optString("handle"), id(local), revision(local)));
      denied(() -> vault.cancelRemote(owner, candidate.optString("handle")));
      check(vault.refreshActive(owner, candidate.getString("handle"), id(local), revision(local)));
      check(!vault.remoteActive(owner, candidate.getString("handle"), id(local), revision(local)));
      check(json(vault.methods(owner, user, id(local), revision(local))).getString("selectedMethod").equals("local"));
      vault.cancelRefresh(owner, candidate.getString("handle"));
      denied(() -> cancelled.client.publicKey());
      check(snapshot().toString().equals(local.toString()));
      NativeRemoteBinding expiring = changed(saved);
      JSONObject expired = json(vault.prepareRefresh(owner, user, expiring, clock[0] + 120_000, id(local), revision(local)));
      clock[0] += 120_000;
      check(!vault.refreshActive(owner, expired.getString("handle"), id(local), revision(local)));
      denied(() -> expiring.client.publicKey());
      check(snapshot().toString().equals(local.toString()));
      NativeRemoteBinding refreshed = changed(saved);
      JSONObject finalCandidate = json(vault.prepareRefresh(owner, user, refreshed, clock[0] + 120_000, id(local), revision(local)));
      NativeMutationReceipt receipt = new NativeMutationReceipt(vault);
      JSONObject committed = json(vault.commitRefresh(owner, finalCandidate.getString("handle"), id(local), revision(local)));
      check(((NativeVault.Error)receipt.failure(new NativeVault.Error("AUTHORIZATION_DENIED"))).code.equals("READBACK_FAILED"));
      check(committed.getLong("revision") == local.getLong("revision") + 1);
      check(committed.getString("selectedPubkey").equals(user));
      check(committed.getJSONArray("identities").toString().equals(local.getJSONArray("identities").toString()));
      JSONObject metadata = json(vault.methods(owner, user, id(committed), revision(committed)));
      check(metadata.getString("selectedMethod").equals("local"));
      check(metadata.getJSONArray("methods").getJSONObject(1).getJSONArray("relays").getString(0).equals("wss://relay2.example.org"));
      vault.close();
      check(json(vault.open(owner)).toString().equals(committed.toString()));
      try (NativeRemoteBinding read = vault.savedRemote(owner, user, id(committed), revision(committed))) {
        check(read.client.publicKey().equals(client));
        check(read.peer.equals(peer));
        check(read.relays.equals(java.util.List.of("wss://relay2.example.org")));
      }
    }
    resetFixture();
  }

  private void legacyFormatCases() throws Exception {
    resetFixture();
    vault = new NativeVault(owner, this);
    JSONObject initial = json(vault.open(owner));
    byte[] scalar = new byte[32]; scalar[31] = 9;
    byte[] legacy = null;
    String pubkey;
    try (NativeSigningKey key = NativeSigningKey.importScalar(scalar);
         NativeSecretBuffer bytes = new NativeSecretBuffer(256);
         java.io.DataOutputStream output = new java.io.DataOutputStream(bytes)) {
      pubkey = key.publicKey();
      output.writeInt(0x48475632); output.writeLong(1); output.write(NativeVault.hex(id(initial)));
      output.write(NativeVault.hex(pubkey)); output.writeByte(1); output.write(NativeVault.hex(pubkey));
      output.writeLong(1760000000000L); output.writeByte(0); key.writeScalar(output); output.flush();
      legacy = bytes.toByteArray();
      new NativeVaultFile(this).write(legacy, false);
    } finally { Arrays.fill(scalar, (byte)0); if (legacy != null) Arrays.fill(legacy, (byte)0); }
    vault.close();
    byte[] original = Files.readAllBytes(file().toPath());
    JSONObject reopened = json(vault.open(owner));
    check(reopened.getString("selectedPubkey").equals(pubkey));
    check(json(vault.methods(owner, pubkey, id(reopened), revision(reopened))).getString("selectedMethod").equals("local"));
    check(Arrays.equals(original, Files.readAllBytes(file().toPath())));
    JSONObject mutation = commit(prepare(7, reopened), reopened);
    byte[] clear = new NativeVaultFile(this).read();
    try { check(java.nio.ByteBuffer.wrap(clear).getInt() == 0x48475634); }
    finally { Arrays.fill(clear, (byte)0); Arrays.fill(original, (byte)0); }
    check(mutation.getJSONArray("identities").length() == 2);
    resetFixture();
  }

  private NativeSigningKey fixtureKey(int value) {
    byte[] scalar = new byte[32]; scalar[31] = (byte)value;
    try { return NativeSigningKey.importScalar(scalar); } finally { Arrays.fill(scalar, (byte)0); }
  }
  private void exactScalar(NativeSigningKey key, int value) throws Exception {
    try (NativeSecretBuffer bytes = new NativeSecretBuffer(32)) {
      key.writeScalar(bytes); byte[] actual = bytes.toByteArray(), expected = new byte[32]; expected[31] = (byte)value;
      try { check(Arrays.equals(actual, expected)); } finally { Arrays.fill(actual, (byte)0); Arrays.fill(expected, (byte)0); }
    }
  }
  private void retainedAndroidMethods(JSONObject expected) throws Exception {
    byte[] bytes = new NativeVaultFile(this).read();
    try (NativeVaultRecordCodec.State state = NativeVaultRecordCodec.decode(bytes)) {
      check(state.id.equals(id(expected))); check(state.revision == revision(expected)); check(state.records.size() == 2);
      NativeVaultRecordCodec.Record account = state.records.get(0), other = state.records.get(1);
      exactScalar(account.key, 9); exactScalar(account.remote.client, 2); exactScalar(other.key, 7);
      check(account.addedAt == 1760000000000L && account.origin == 1);
      check(other.addedAt == 1760000000001L && other.origin == 0 && other.method == NativeVault.LOCAL);
      try (NativeSigningKey peer = fixtureKey(3)) { check(account.remote.peer.equals(peer.publicKey())); }
      check(account.remote.relays.equals(java.util.List.of("wss://relay.example.org")));
      check(account.pubkey.equals(expected.getString("selectedPubkey")));
    } finally { Arrays.fill(bytes, (byte)0); }
  }
  private JSONObject installHgv3Fixture(long[] clock) throws Exception {
    resetFixture(); vault = new NativeVault(owner, this, () -> clock[0]); JSONObject created = json(vault.open(owner));
    try (NativeSigningKey user = fixtureKey(9); NativeSigningKey other = fixtureKey(7); NativeSigningKey client = fixtureKey(2); NativeSigningKey peer = fixtureKey(3);
         NativeSecretBuffer bytes = new NativeSecretBuffer(512); java.io.DataOutputStream output = new java.io.DataOutputStream(bytes)) {
      output.writeInt(0x48475633); output.writeLong(1); output.write(NativeVault.hex(id(created)));
      output.write(NativeVault.hex(user.publicKey())); output.writeByte(2);
      output.write(NativeVault.hex(user.publicKey())); output.writeLong(1760000000000L); output.writeByte(1); output.writeByte(NativeVault.LOCAL);
      output.writeBoolean(true); user.writeScalar(output); output.writeBoolean(true); client.writeScalar(output);
      output.write(NativeVault.hex(peer.publicKey())); output.writeByte(1); output.writeUTF("wss://relay.example.org");
      output.write(NativeVault.hex(other.publicKey())); output.writeLong(1760000000001L); output.writeByte(0); output.writeByte(NativeVault.LOCAL);
      output.writeBoolean(true); other.writeScalar(output); output.writeBoolean(false); output.flush();
      byte[] legacy = bytes.toByteArray(); try { new NativeVaultFile(this).write(legacy, false); } finally { Arrays.fill(legacy, (byte)0); }
    }
    vault.close(); byte[] before = Files.readAllBytes(file().toPath());
    vault = new NativeVault(owner, this, () -> clock[0]); JSONObject opened = json(vault.open(owner));
    check(id(opened).equals(id(created))); check(revision(opened) == 1);
    check(json(vault.methods(owner, opened.getString("selectedPubkey"), id(opened), revision(opened))).getString("selectedMethod").equals("local"));
    try { check(Arrays.equals(before, Files.readAllBytes(file().toPath()))); } finally { Arrays.fill(before, (byte)0); }
    retainedAndroidMethods(opened); return opened;
  }
  private void androidSignerStorageCases() throws Exception {
    long[] clock = {100}; JSONObject initial = installHgv3Fixture(clock); String user = initial.getString("selectedPubkey");
    java.util.ArrayList<String> certificates = new java.util.ArrayList<>(java.util.List.of("01".repeat(32), "02".repeat(32)));
    NativeAndroidSignerBinding binding = new NativeAndroidSignerBinding("org.example.disposable.signer", certificates);
    certificates.clear(); check(binding.certificateSha256s.size() == 2);
    denied(() -> vault.prepareAndroidSigner(new Object(), user, binding, clock[0] + 120_000, id(initial), revision(initial)));
    denied(() -> vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_001, id(initial), revision(initial)));
    JSONObject prepared = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(initial), revision(initial)));
    String handle = prepared.getString("handle"); check(prepared.length() == 2 && prepared.getString("pubkey").equals(user));
    check(vault.androidCandidateBinding(owner, handle, id(initial), revision(initial)).sameInstallation(binding));
    check(vault.androidSignerReview(owner, handle, id(initial), revision(initial)).contains(binding.packageName));
    byte[] unchanged = Files.readAllBytes(file().toPath());
    denied(() -> vault.commitImport(owner, handle, id(initial), revision(initial)));
    denied(() -> vault.commitRemote(owner, handle, id(initial), revision(initial)));
    denied(() -> vault.commitAndroidSigner(new Object(), handle, id(initial), revision(initial)));
    denied(() -> vault.commitAndroidSigner(owner, handle, id(initial), revision(initial) + 1));
    denied(() -> vault.commitRefresh(owner, handle, id(initial), revision(initial)));
    try { check(Arrays.equals(unchanged, Files.readAllBytes(file().toPath()))); } finally { Arrays.fill(unchanged, (byte)0); }
    NativeMutationReceipt receipt = new NativeMutationReceipt(vault);
    JSONObject connected = json(vault.commitAndroidSigner(owner, handle, id(initial), revision(initial)));
    check(((NativeVault.Error)receipt.failure(new NativeVault.Error("AUTHORIZATION_DENIED"))).code.equals("READBACK_FAILED"));
    check(revision(connected) == 2 && connected.getJSONArray("identities").toString().equals(initial.getJSONArray("identities").toString()));
    check(vault.androidSigning(owner, user, id(connected), revision(connected)).sameInstallation(binding));
    retainedAndroidMethods(connected);
    byte[] hgv4 = new NativeVaultFile(this).read(); try { check(java.nio.ByteBuffer.wrap(hgv4).getInt() == 0x48475634); } finally { Arrays.fill(hgv4, (byte)0); }
    byte[] committed = Files.readAllBytes(file().toPath());
    denied(() -> vault.commitAndroidSigner(owner, handle, id(connected), revision(connected)));
    try { check(Arrays.equals(committed, Files.readAllBytes(file().toPath()))); } finally { Arrays.fill(committed, (byte)0); }
    vault.close(); vault = new NativeVault(owner, this, () -> clock[0]); check(json(vault.open(owner)).toString().equals(connected.toString()));
    check(vault.androidSigning(owner, user, id(connected), revision(connected)).sameInstallation(binding));
    JSONObject methods = json(vault.methods(owner, user, id(connected), revision(connected)));
    check(methods.getString("selectedMethod").equals("nip55") && methods.getJSONArray("methods").length() == 3);
    denied(() -> vault.signingKey(owner, user, id(connected), revision(connected)));
    JSONObject removed = json(vault.disconnect(owner, user, "nip55", id(connected), revision(connected)));
    check(json(vault.methods(owner, user, id(removed), revision(removed))).isNull("selectedMethod"));
    denied(() -> vault.signingKey(owner, user, id(removed), revision(removed)));
    denied(() -> vault.androidSigning(owner, user, id(removed), revision(removed))); retainedAndroidMethods(removed);
    JSONObject local = json(vault.selectMethod(owner, user, "local", id(removed), revision(removed)));
    try (NativeSigningKey restored = vault.signingKey(owner, user, id(local), revision(local))) { exactScalar(restored, 9); }
    JSONObject expiring = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(local), revision(local)));
    clock[0] += 120_000; denied(() -> vault.commitAndroidSigner(owner, expiring.optString("handle"), id(local), revision(local)));
    JSONObject cancelled = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(local), revision(local)));
    vault.cancelAndroidSigner(owner, cancelled.getString("handle")); denied(() -> vault.commitAndroidSigner(owner, cancelled.optString("handle"), id(local), revision(local)));
    JSONObject idleExpiry = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(local), revision(local)));
    clock[0] += 120_000;
    JSONObject replacement = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(local), revision(local)));
    denied(() -> vault.commitAndroidSigner(owner, idleExpiry.optString("handle"), id(local), revision(local)));
    vault.cancelAndroidSigner(owner, replacement.getString("handle")); check(snapshot().toString().equals(local.toString()));
    JSONObject reconnect = json(vault.prepareAndroidSigner(owner, user, binding, clock[0] + 120_000, id(local), revision(local)));
    JSONObject linkedAgain = json(vault.commitAndroidSigner(owner, reconnect.getString("handle"), id(local), revision(local)));
    JSONObject keepLocal = json(vault.selectMethod(owner, user, "local", id(linkedAgain), revision(linkedAgain)));
    JSONObject inactiveRemoved = json(vault.disconnect(owner, user, "nip55", id(keepLocal), revision(keepLocal)));
    check(json(vault.methods(owner, user, id(inactiveRemoved), revision(inactiveRemoved))).getString("selectedMethod").equals("local"));
    retainedAndroidMethods(inactiveRemoved);
    resetFixture();
  }

  private void fileCases() throws Exception {
    vault.close(); byte[] original = Files.readAllBytes(file().toPath());
    Files.write(new File(file().getPath() + ".new").toPath(), new byte[]{1, 2});
    vault = new NativeVault(owner, this); vault.open(owner); check(Arrays.equals(original, Files.readAllBytes(file().toPath()))); vault.close();
    byte[] damaged = original.clone(); damaged[damaged.length - 1] ^= 1; Files.write(file().toPath(), damaged);
    vault = new NativeVault(owner, this); denied(() -> vault.open(owner)); check(Arrays.equals(damaged, Files.readAllBytes(file().toPath())));
    Files.write(file().toPath(), original); vault = new NativeVault(owner, this); vault.open(owner); vault.close();
    check(file().delete()); vault = new NativeVault(owner, this); denied(() -> vault.open(owner)); check(!file().exists());
    Files.write(file().toPath(), original);
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); keys.deleteEntry(ALIAS);
    vault = new NativeVault(owner, this); denied(() -> vault.open(owner)); check(!keys.containsAlias(ALIAS)); check(Arrays.equals(original, Files.readAllBytes(file().toPath())));
    resetFixture(); Files.write(new File(file().getPath() + ".new").toPath(), new byte[]{1, 2});
    vault = new NativeVault(owner, this); denied(() -> vault.open(owner)); check(!keys.containsAlias(ALIAS));
    resetFixture(); NativeVaultFile storage = new NativeVaultFile(this); storage.write(new byte[]{1, 2, 3}, true);
    vault = new NativeVault(owner, this); denied(() -> vault.open(owner));
    resetFixture(); Arrays.fill(original, (byte)0); Arrays.fill(damaged, (byte)0);
  }
  private void cold() throws Exception {
    JSONObject expected = new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(), "restart.json").toPath()), StandardCharsets.UTF_8));
    long[] clock = {100}; vault = new NativeVault(owner, this, () -> clock[0]);
    check(json(vault.open(owner)).toString().equals(expected.toString()));
    codecCases(); inventoryCases(clock); assertions += NativeSessionRaceProof.run();
    JSONObject state = snapshot(); String key = state.getString("selectedPubkey");
    String event = "{\"pubkey\":\"" + key + "\",\"created_at\":1760000000,\"kind\":1,\"tags\":[[\"t\",\"native-vault-proof\"]],\"content\":\"Stored native key after encrypted cold restart\"}";
    publicEvent = new JSONObject(event);
    reviewCore = NativeSignerCore.ownedKey(owner, vault.signingKey(owner, key, id(state), revision(state)));
    NativeSignerCore.Review review = reviewCore.admit(owner, event);
    panel.show(this, reviewCore, owner, review, "Disposable native vault proof", "Encrypted vault key", java.util.List.of("No publication"),
      () -> !isFinishing(), () -> reviewCore.approveOnce(owner, review), signed -> {
        try {
          check(signed != null); check(new JSONObject(signed).getString("pubkey").equals(key));
          denied(() -> reviewCore.approveOnce(owner, review)); reviewCore.close();
          fileCases(); replyCancellationCases(); methodCases(); legacyFormatCases(); methodReplyCancellationCases(); refreshCases(); androidSignerStorageCases(); assertions += NativeAndroidSignerModelProof.run(this);
          write("result.json", new JSONObject().put("status", "passed").put("assertions", assertions)
            .put("unsignedEvent", publicEvent).put("signedEvent", new JSONObject(signed)));
          ((TextView)findViewById(android.R.id.text1)).setText("Native encrypted restart, import, corruption and cancellation checks passed.");
        } catch (Throwable failure) { failed(failure); }
      });
  }
  private void failed(Throwable failure) {
    try { write("result.json", new JSONObject().put("status", "failed").put("assertions", assertions).put("error", failure.getClass().getSimpleName()).put("modelAssertions", NativeAndroidSignerModelProof.completedAssertions())); }
    catch (Exception ignored) {}
  }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state); TextView text = new TextView(this); text.setId(android.R.id.text1); setContentView(text);
    try {
      if (!PACKAGE.equals(getPackageName())) throw new Exception("Disposable package required");
      if ("validators".equals(getIntent().getStringExtra("phase"))) {
        assertions=NativeAndroidSignerModelProof.run(this);
        write("result.json",NativeAndroidSignerModelProof.trace().put("status","passed").put("assertions",assertions));
        text.setText("Native Android signer validator checks passed.");
      }
      else if ("fresh".equals(getIntent().getStringExtra("phase"))) fresh();
      else if ("cold".equals(getIntent().getStringExtra("phase"))) cold();
      else throw new Exception("Explicit proof phase required");
    } catch (Throwable failure) { failed(failure); }
  }
  @Override public void onDestroy() {
    panel.cancel(); if (reviewCore != null) reviewCore.close(); if (vault != null) vault.close(); super.onDestroy();
  }
}
