package org.nostrocket.hypergolic.signercore;

import java.util.UUID;
import org.json.JSONObject;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.Record;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;
import org.nostrocket.hypergolic.signercore.NativeVault.Error;
import static org.nostrocket.hypergolic.signercore.NativeVault.*;

/** One native Android connection purpose, revision and original deadline. */
final class NativeAndroidSignerCandidates {
  private static final class Candidate {
    final String handle = UUID.randomUUID().toString(), vault, pubkey;
    final long revision, deadline;
    final NativeAndroidSignerBinding binding;
    Candidate(State state, String pubkey, NativeAndroidSignerBinding binding, long deadline) {
      vault = state.id; revision = state.revision;
      this.pubkey = pubkey; this.binding = binding; this.deadline = deadline;
    }
  }
  private final NativeVault records;
  private Candidate candidate;
  NativeAndroidSignerCandidates(NativeVault records) { this.records = records; }
  boolean pending(long now) { if (candidate != null && (now < 0 || now >= candidate.deadline)) candidate = null; return candidate != null; }
  void clear() { candidate = null; }
  String prepare(State state, String pubkey, NativeAndroidSignerBinding binding, long deadline, long now) {
    if (!NativeSigningKey.validPublicKey(pubkey) || binding == null) throw new Error("SIGNER_RESPONSE_INVALID");
    if (now < 0 || deadline <= now || deadline - now > 120_000L) throw new Error("SIGNER_EXPIRED");
    if (candidate != null) throw new Error("NOT_READY");
    Record existing = state.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst().orElse(null);
    if (existing != null && existing.androidSigner != null) throw new Error("SIGNER_ALREADY_CONNECTED");
    if (existing == null && state.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
    Candidate next = new Candidate(state, pubkey, binding, deadline);
    try {
      String publicCandidate = new JSONObject().put("handle", next.handle).put("pubkey", next.pubkey).toString();
      candidate = next;
      return publicCandidate;
    } catch (Exception failure) { throw new Error("STORAGE_FAILURE"); }
  }
  private Candidate current(State state, String handle, long now) {
    if (candidate != null && now >= candidate.deadline) candidate = null;
    Candidate next = candidate;
    if (now < 0 || next == null || !next.handle.equals(handle) || !next.vault.equals(state.id) || next.revision != state.revision) {
      throw new Error("SIGNER_EXPIRED");
    }
    return next;
  }
  String review(State state, String handle, long now) {
    Candidate next = current(state, handle, now);
    return "Connect and use this Android signer for identity:\n" + next.pubkey + "\n\nInstalled package:\n" + next.binding.packageName +
      "\n\nCurrent signing certificates (SHA-256):\n" + String.join("\n", next.binding.certificateSha256s) +
      "\n\nExisting local keys, remote signers and account data remain available. Pending requests will be cancelled.";
  }
  NativeAndroidSignerBinding binding(State state, String handle, long now) { return current(state, handle, now).binding; }
  String commit(State state, String handle, long now) {
    Candidate next = current(state, handle, now);
    Record existing = state.records.stream().filter(value -> value.pubkey.equals(next.pubkey)).findFirst().orElse(null);
    if (existing != null && existing.androidSigner != null) throw new Error("SIGNER_ALREADY_CONNECTED");
    if (existing == null && state.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
    advance(state);
    if (existing == null) {
      existing = new Record(next.pubkey, null, null, timestamp(), 2, NIP55);
      state.records.add(existing);
    }
    existing.androidSigner = next.binding; existing.method = NIP55; state.selected = existing.pubkey;
    candidate = null;
    records.persist(state, false);
    return NativeVaultMetadata.snapshot(state);
  }
  void cancel(String handle) { if (candidate != null && candidate.handle.equals(handle)) candidate = null; }
}
