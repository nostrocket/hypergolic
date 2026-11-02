package org.nostrocket.hypergolic.signercore;

import android.content.Context;
import android.os.SystemClock;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.Record;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;
import static org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.*;
import static org.nostrocket.hypergolic.signercore.NativeVaultMetadata.snapshot;

/** Owns the fresh native namespace; only public snapshots and one-use import handles leave this class. */
final class NativeVault implements AutoCloseable {
  static final long MAX_REVISION = 9_007_199_254_740_991L;
  static final int MAX_IDENTITIES = 16;
  static final int NO_METHOD = 0, LOCAL = 1, NIP46 = 2, NIP55 = 3;
  static final class Error extends RuntimeException {
    final String code;
    Error(String code) { super(code); this.code = code; }
  }
  private static final class Candidate {
    final String handle, vault; final long revision, deadline; final Record record;
    Candidate(State state, Record record, long now) {
      this.handle = UUID.randomUUID().toString(); this.vault = state.id; this.revision = state.revision;
      if (now < 0 || now > Long.MAX_VALUE - 120_000L) throw new Error("AUTHORIZATION_DENIED");
      this.record = record; this.deadline = now + 120_000L;
    }
  }
  private NativeConnectionCandidate remoteCandidate;
  private final NativeAndroidSignerCandidates androidCandidates = new NativeAndroidSignerCandidates(this);
  private final Object owner;
  private final NativeVaultFile file;
  private final LongSupplier clock;
  private State state;
  private Candidate candidate;
  private boolean poisoned, initialized;
  private long committedWrites;

  NativeVault(Object owner, Context context) { this(owner, context, SystemClock::elapsedRealtime); }
  /** Native-only deterministic clock seam; the Expo module always uses the OS clock. */
  NativeVault(Object owner, Context context, LongSupplier clock) {
    if (owner == null || context == null || clock == null) throw new Error("NOT_READY");
    this.owner = owner; this.clock = clock; file = new NativeVaultFile(context);
  }
  private void owned(Object context) { if (owner != context || poisoned) throw new Error("AUTHORIZATION_DENIED"); }
  private State opened(Object context) {
    owned(context);
    if (!initialized) throw new Error("NOT_READY");
    if (state == null) {
      byte[] encoded=null;
      try { encoded=file.read(); if(encoded==null)throw new Error("RECOVERY_REQUIRED");state=decode(encoded); }
      catch(RuntimeException failure) { poisoned=true;releaseState();throw failure; }
      finally { if(encoded!=null)Arrays.fill(encoded,(byte)0); }
    }
    return state;
  }
  static long timestamp() {
    long value = System.currentTimeMillis();
    if (value < 0 || value > MAX_REVISION) throw new Error("STORAGE_FAILURE");
    return value;
  }
  private static String id() { byte[] bytes = new byte[16]; new SecureRandom().nextBytes(bytes); return NativeEvent.hex(bytes); }
  static byte[] hex(String value) {
    if (value == null || !value.matches("[0-9a-f]+") || value.length() % 2 != 0) throw new Error("CORRUPT_METADATA");
    byte[] result = new byte[value.length()/2];
    for (int i=0; i<result.length; i++) result[i] = (byte)((Character.digit(value.charAt(2*i),16)<<4) | Character.digit(value.charAt(2*i+1),16));
    return result;
  }
  void persist(State value, boolean initialize) {
    byte[] clear = null;
    try { clear=encode(value); file.write(clear, initialize); value.persistedHash=hash(clear); committedWrites++; }
    catch (RuntimeException failure) { poisoned = true; close(); throw failure; }
    finally { if (clear!=null) Arrays.fill(clear,(byte)0); }
  }
  private String openInternal(Object context) {
    owned(context); if (state != null) { verifyCurrent(); return snapshot(state); }
    byte[] encoded = null;
    try {
      encoded = file.read();
      if (encoded != null) state = decode(encoded);
      else {
        State next = new State();
        try { next.id = id(); next.revision=1; Record first = new Record(new NativeSigningKey(), timestamp(), 0); next.records.add(first); next.selected=first.pubkey; persist(next,true); state=next; }
        catch (RuntimeException failure) { next.close(); throw failure; }
      }
      initialized=true; return snapshot(state);
    } catch (RuntimeException failure) { poisoned=true; close(); throw failure; }
    finally { if (encoded != null) Arrays.fill(encoded,(byte)0); }
  }
  private void verifyCurrent() {
    if (state == null) throw new Error("NOT_READY");
    byte[] actual = null, expected = null;
    try {
      actual = file.read(); expected=actual==null?null:hash(actual);
      if (actual == null || !MessageDigest.isEqual(state.persistedHash,expected)) throw new Error("READBACK_FAILED");
    } catch (RuntimeException failure) { poisoned=true; close(); throw failure; }
    finally { if (actual != null) Arrays.fill(actual,(byte)0); if (expected != null) Arrays.fill(expected,(byte)0); }
  }
  State expected(Object context,String vault,long revision) {
    State value=opened(context); verifyCurrent();
    if (!value.id.equals(vault) || value.revision != revision) throw new Error("READBACK_FAILED");
    return value;
  }
  private String snapshotInternal(Object context) { State current=opened(context); verifyCurrent(); return snapshot(current); }
  private String prepareInternal(Object context,NativeSigningKey key,String vault,long revision) {
    State current=expected(context,vault,revision);
    if (hasCandidate()) throw new Error("NOT_READY");
    Record record=new Record(key,timestamp(),1);
    boolean existing=current.records.stream().anyMatch(value -> value.pubkey.equals(record.pubkey));
    if (!existing && current.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
    candidate=new Candidate(current,record,clock.getAsLong());
    try { return new JSONObject().put("handle",candidate.handle).put("pubkey",record.pubkey).toString(); }
    catch (Exception failure) { cancelImport(context,candidate.handle); throw new Error("STORAGE_FAILURE"); }
  }
  synchronized void cancelImport(Object context,String handle) {
    owned(context);
    if (candidate != null && candidate.handle.equals(handle)) { candidate.record.key.close(); candidate=null; }
  }
  private String commitInternal(Object context,String handle,String vault,long revision) {
    State current=expected(context,vault,revision); Candidate next=candidate;
    if (next!=null && next.handle.equals(handle) && clock.getAsLong()>=next.deadline) {
      next.record.key.close();candidate=null;throw new Error("AUTHORIZATION_DENIED");
    }
    if (next==null || !next.handle.equals(handle) || !next.vault.equals(vault) || next.revision!=revision) throw new Error("AUTHORIZATION_DENIED");
    if (current.revision>=MAX_REVISION) throw new Error("STORAGE_FAILURE");
    candidate=null;
    Record existing = current.records.stream().filter(value -> value.pubkey.equals(next.record.pubkey)).findFirst().orElse(null);
    if (existing != null) {
      boolean changed = !current.selected.equals(existing.pubkey) || existing.method != LOCAL || existing.key == null;
      if (existing.key == null) existing.key = next.record.key;
      else next.record.close();
      existing.method = LOCAL;
      current.selected = existing.pubkey;
      if (changed) { current.revision++; persist(current, false); }
      return snapshot(current);
    }
    if (current.records.size()>=MAX_IDENTITIES) { next.record.key.close(); throw new Error("LIMIT_REACHED"); }
    current.records.add(next.record); current.selected=next.record.pubkey; current.revision++;
    persist(current,false); return snapshot(current);
  }
  private String selectInternal(Object context,String pubkey,String vault,long revision) {
    State current=expected(context,vault,revision);
    if (hasCandidate()) throw new Error("NOT_READY");
    if (current.records.stream().noneMatch(value -> value.pubkey.equals(pubkey))) throw new Error("NOT_FOUND");
    if (current.selected.equals(pubkey)) return snapshot(current);
    if (current.revision>=MAX_REVISION) throw new Error("STORAGE_FAILURE");
    current.selected=pubkey; current.revision++; persist(current,false); return snapshot(current);
  }
  private void deleteInternal(Object context,String pubkey,String vault,long revision) {
    State current=expected(context,vault,revision);
    if (current.selected.equals(pubkey) || current.records.size()<2) throw new Error("DELETE_SELECTED");
    Record removed=current.records.stream().filter(record -> record.pubkey.equals(pubkey)).findFirst().orElseThrow(() -> new Error("NOT_FOUND"));
    if (current.revision>=MAX_REVISION) throw new Error("STORAGE_FAILURE");
    current.records.remove(removed); current.revision++;
    try { persist(current,false); } finally { removed.close(); }
  }
  private NativeSigningKey signingInternal(Object context,String pubkey,String vault,long revision) {
    State current=expected(context,vault,revision);
    if (!current.selected.equals(pubkey)) throw new Error("AUTHORIZATION_DENIED");
    Record record=current.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst().orElseThrow(() -> new Error("NOT_FOUND"));
    if (record.method != LOCAL) throw new Error("SIGNER_UNAVAILABLE");
    if (record.key == null) throw new Error("LOCAL_KEY_UNAVAILABLE");
    return record.key.copy();
  }
  private byte[] backupInternal(Object context,String pubkey,String vault,long revision) {
    State current=expected(context,vault,revision);
    if (!current.selected.equals(pubkey)) throw new Error("AUTHORIZATION_DENIED");
    Record record=current.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst().orElseThrow(() -> new Error("NOT_FOUND"));
    if (record.key == null) throw new Error("LOCAL_KEY_UNAVAILABLE");
    try (NativeSecretBuffer buffer=new NativeSecretBuffer(32)) { record.key.writeScalar(buffer); return buffer.toByteArray(); }
  }
  synchronized String methods(Object context, String pubkey, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      return NativeVaultMetadata.methods(current, record(current, pubkey));
    } finally { releaseState(); }
  }
  static void advance(State current) {
    if (current.revision >= MAX_REVISION) throw new Error("STORAGE_FAILURE");
    current.revision++;
  }
  private Record selected(State current, String pubkey) {
    if (!current.selected.equals(pubkey)) throw new Error("AUTHORIZATION_DENIED");
    return record(current, pubkey);
  }
  synchronized String selectMethod(Object context, String pubkey, String method, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      Record value = selected(current, pubkey);
      if (hasCandidate()) throw new Error("NOT_READY");
      long previous = current.revision;
      NativeVaultMethods.select(current, value, method);
      if (current.revision != previous) persist(current, false);
      return snapshot(current);
    } finally { releaseState(); }
  }
  synchronized String disconnect(Object context, String pubkey, String method, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      Record value = selected(current, pubkey);
      NativeVaultMethods.disconnect(current, value, method);
      persist(current, false);
      return snapshot(current);
    } finally { releaseState(); }
  }
  synchronized void deleteLocal(Object context, String pubkey, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      Record value = selected(current, pubkey);
      if (value.key == null) throw new Error("LOCAL_KEY_UNAVAILABLE");
      advance(current);
      value.key.close();
      value.key = null;
      if (value.method == LOCAL) value.method = NO_METHOD;
      persist(current, false);
    } finally { releaseState(); }
  }
  synchronized NativeRemoteBinding remoteSigning(Object context, String pubkey, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      Record value = selected(current, pubkey);
      if (value.method != NIP46 || value.remote == null) throw new Error("SIGNER_UNAVAILABLE");
      return value.remote.copy();
    } finally { releaseState(); }
  }
  synchronized NativeRemoteBinding savedRemote(Object context, String pubkey, String vault, long revision) {
    try {
      Record value = selected(expected(context, vault, revision), pubkey);
      if (value.remote == null) throw new Error("SIGNER_UNAVAILABLE");
      return value.remote.copy();
    } finally { releaseState(); }
  }
  synchronized boolean refreshActive(Object context, String handle, String vault, long revision) {
    try { remote(context, handle, vault, revision, true); return true; }
    catch (RuntimeException failure) { return false; }
  }
  synchronized String refreshReview(Object context, String handle, String vault, long revision) {
    NativeConnectionCandidate value = remote(context, handle, vault, revision, true);
    return "Identity:\n" + value.pubkey + "\n\nSigner peer:\n" + value.binding.peer +
      "\n\nUse exactly these signer relays:\n" + String.join("\n", value.binding.relays) +
      "\n\nAccount data and the selected signing method remain unchanged. Pending requests will be cancelled.";
  }
  synchronized String prepareRemote(Object context, String pubkey, NativeRemoteBinding binding, long deadline, String vault, long revision) {
    try { return prepareConnection(expected(context, vault, revision), pubkey, binding, deadline, false); }
    finally { releaseState(); }
  }
  synchronized String prepareRefresh(Object context, String pubkey, NativeRemoteBinding binding, long deadline, String vault, long revision) {
    try { return prepareConnection(expected(context, vault, revision), pubkey, binding, deadline, true); }
    finally { releaseState(); }
  }
  private String prepareConnection(State current, String pubkey, NativeRemoteBinding binding, long deadline, boolean refresh) {
    try {
      long now = clock.getAsLong();
      if (now < 0 || deadline <= now || deadline - now > 120_000L) throw new Error("SIGNER_EXPIRED");
      if (!NativeSigningKey.validPublicKey(pubkey)) throw new Error("SIGNER_RESPONSE_INVALID");
      if (hasCandidate()) throw new Error("NOT_READY");
      Record existing = current.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst().orElse(null);
      if (refresh) {
        if (!current.selected.equals(pubkey) || existing == null || existing.remote == null ||
            !existing.remote.peer.equals(binding.peer) || !existing.remote.client.publicKey().equals(binding.client.publicKey())) {
          throw new Error("AUTHORIZATION_DENIED");
        }
        if (existing.remote.relays.equals(binding.relays)) throw new Error("SIGNER_UNSUPPORTED");
      } else if (existing != null && existing.remote != null) throw new Error("SIGNER_ALREADY_CONNECTED");
      if (existing == null && current.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
      remoteCandidate = new NativeConnectionCandidate(current, pubkey, binding, deadline, refresh);
      return new JSONObject().put("handle", remoteCandidate.handle).put("pubkey", pubkey).toString();
    } catch (Error failure) { throw failure; }
    catch (Exception failure) { throw new Error("STORAGE_FAILURE"); }
  }
  private NativeConnectionCandidate remote(Object context, String handle, String vault, long revision) {
    return remote(context, handle, vault, revision, false);
  }
  private NativeConnectionCandidate remote(Object context, String handle, String vault, long revision, boolean refresh) {
    owned(context);
    if (remoteCandidate != null && clock.getAsLong() >= remoteCandidate.deadline) {
      remoteCandidate.binding.close();
      remoteCandidate = null;
    }
    NativeConnectionCandidate value = remoteCandidate;
    if (value == null || !value.handle.equals(handle) || !value.vault.equals(vault) || value.revision != revision || value.refresh != refresh) {
      throw new Error("SIGNER_EXPIRED");
    }
    return value;
  }
  synchronized boolean remoteActive(Object context, String handle, String vault, long revision) {
    try { remote(context, handle, vault, revision); return true; }
    catch (RuntimeException failure) { return false; }
  }
  synchronized String remoteReview(Object context, String handle, String vault, long revision) {
    NativeConnectionCandidate value = remote(context, handle, vault, revision);
    try {
      State current = expected(context, vault, revision);
      Record existing = current.records.stream().filter(record -> record.pubkey.equals(value.pubkey)).findFirst().orElse(null);
      return "Connect and use this signer for identity:\n" + value.pubkey + "\n\nSigner peer:\n" + value.binding.peer +
        "\n\nSigner relays:\n" + String.join("\n", value.binding.relays) +
        (existing != null && existing.key != null ? "\n\nThe local key remains available." : "\n\nNo local key is stored for this identity.");
    } finally { releaseState(); }
  }
  synchronized String commitRemote(Object context, String handle, String vault, long revision) {
    return commitConnection(context, handle, vault, revision, false);
  }
  synchronized String commitRefresh(Object context, String handle, String vault, long revision) {
    return commitConnection(context, handle, vault, revision, true);
  }
  private String commitConnection(Object context, String handle, String vault, long revision, boolean refresh) {
    NativeRemoteBinding previous = null;
    try {
      State current = expected(context, vault, revision);
      NativeConnectionCandidate pending = remote(context, handle, vault, revision, refresh);
      Record existing = current.records.stream().filter(value -> value.pubkey.equals(pending.pubkey)).findFirst().orElse(null);
      if (refresh) {
        if (!current.selected.equals(pending.pubkey) || existing == null || existing.remote == null ||
            !existing.remote.peer.equals(pending.binding.peer) || !existing.remote.client.publicKey().equals(pending.binding.client.publicKey())) {
          throw new Error("AUTHORIZATION_DENIED");
        }
        previous = existing.remote;
      } else if (existing != null && existing.remote != null) throw new Error("SIGNER_ALREADY_CONNECTED");
      if (existing == null && current.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
      advance(current);
      if (existing == null) {
        existing = new Record(pending.pubkey, null, pending.binding, timestamp(), 2, NIP46);
        current.records.add(existing);
      } else { existing.remote = pending.binding; if (!refresh) existing.method = NIP46; }
      remoteCandidate = null;
      current.selected = existing.pubkey;
      persist(current, false);
      return snapshot(current);
    } finally { if (previous != null) previous.close(); releaseState(); }
  }
  synchronized void cancelRemote(Object context, String handle) { cancelConnection(context, handle, false); }
  synchronized void cancelRefresh(Object context, String handle) { cancelConnection(context, handle, true); }
  private void cancelConnection(Object context, String handle, boolean refresh) {
    owned(context);
    if (remoteCandidate != null && remoteCandidate.handle.equals(handle)) {
      if (remoteCandidate.refresh != refresh) throw new Error("AUTHORIZATION_DENIED");
      remoteCandidate.binding.close();
      remoteCandidate = null;
    }
  }
  private boolean hasCandidate() { return candidate != null || remoteCandidate != null || androidCandidates.pending(clock.getAsLong()); }
  synchronized String prepareAndroidSigner(Object context, String pubkey, NativeAndroidSignerBinding binding, long deadline, String vault, long revision) {
    try {
      State current = expected(context, vault, revision);
      if (hasCandidate()) throw new Error("NOT_READY");
      return androidCandidates.prepare(current, pubkey, binding, deadline, clock.getAsLong());
    } finally { releaseState(); }
  }
  synchronized String androidSignerReview(Object context, String handle, String vault, long revision) {
    try { return androidCandidates.review(expected(context, vault, revision), handle, clock.getAsLong()); }
    finally { releaseState(); }
  }
  synchronized NativeAndroidSignerBinding androidCandidateBinding(Object context, String handle, String vault, long revision) {
    try { return androidCandidates.binding(expected(context, vault, revision), handle, clock.getAsLong()); }
    finally { releaseState(); }
  }
  synchronized String commitAndroidSigner(Object context, String handle, String vault, long revision) {
    try { return androidCandidates.commit(expected(context, vault, revision), handle, clock.getAsLong()); }
    finally { releaseState(); }
  }
  synchronized void cancelAndroidSigner(Object context, String handle) { owned(context); androidCandidates.cancel(handle); }
  synchronized NativeAndroidSignerBinding androidSigning(Object context, String pubkey, String vault, long revision) {
    try {
      Record value = selected(expected(context, vault, revision), pubkey);
      if (value.method != NIP55 || value.androidSigner == null) throw new Error("SIGNER_UNAVAILABLE");
      return value.androidSigner;
    } finally { releaseState(); }
  }
  synchronized long committedWrites() { return committedWrites; }
  private void releaseState() { if(state!=null) { state.close();state=null; } }
  synchronized String open(Object context) { try { return openInternal(context); } finally { releaseState(); } }
  synchronized String publicSnapshot(Object context) { try { return snapshotInternal(context); } finally { releaseState(); } }
  synchronized String prepareImport(Object context,NativeSigningKey key,String vault,long revision) { try { return prepareInternal(context,key,vault,revision); } finally { releaseState(); } }
  synchronized String commitImport(Object context,String handle,String vault,long revision) { try { return commitInternal(context,handle,vault,revision); } finally { releaseState(); } }
  synchronized String select(Object context,String pubkey,String vault,long revision) { try { return selectInternal(context,pubkey,vault,revision); } finally { releaseState(); } }
  synchronized void delete(Object context,String pubkey,String vault,long revision) { try { deleteInternal(context,pubkey,vault,revision); } finally { releaseState(); } }
  synchronized NativeSigningKey signingKey(Object context,String pubkey,String vault,long revision) { try { return signingInternal(context,pubkey,vault,revision); } finally { releaseState(); } }
  synchronized byte[] backupScalar(Object context,String pubkey,String vault,long revision) { try { return backupInternal(context,pubkey,vault,revision); } finally { releaseState(); } }
  synchronized String importIdentity(Object context,String handle,String vault,long revision) {
    owned(context);
    if(candidate!=null && clock.getAsLong()>=candidate.deadline) { candidate.record.key.close();candidate=null; }
    if(candidate==null || !candidate.handle.equals(handle) || !candidate.vault.equals(vault) || candidate.revision!=revision)throw new Error("AUTHORIZATION_DENIED");
    return candidate.record.pubkey;
  }
  synchronized boolean importActive(Object context,String handle,String vault,long revision) {
    try { importIdentity(context,handle,vault,revision);return true; } catch(RuntimeException failure) { return false; }
  }
  synchronized void assertRevision(Object context,String vault,long revision) { try { expected(context,vault,revision); } finally { releaseState(); } }
  synchronized void cancelImports(Object context) {
    owned(context);
    androidCandidates.clear();
    if (candidate != null) { candidate.record.close(); candidate = null; }
    if (remoteCandidate != null) { remoteCandidate.binding.close(); remoteCandidate = null; }
  }
  @Override public synchronized void close() {
    androidCandidates.clear();
    if (remoteCandidate != null) { remoteCandidate.binding.close(); remoteCandidate = null; }
    if (candidate!=null) { candidate.record.key.close(); candidate=null; }
    if (state!=null) { state.close(); state=null; }
  }
}
