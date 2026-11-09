package org.nostrocket.hypergolic.signercore;

import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import org.json.JSONObject;
import org.nostrocket.hypergolic.signercore.NativeVault.Error;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.Record;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;
import static org.nostrocket.hypergolic.signercore.NativeVault.*;

/** One native purpose, base record revision and original deadline; never a reusable review grant. */
final class NativeConnectionCandidate {
  private final String handle = UUID.randomUUID().toString();
  private final String vault, pubkey;
  private final long revision, deadline;
  private final boolean refresh;
  private final NativeRemoteBinding binding;

  private NativeConnectionCandidate(State state, String pubkey, NativeRemoteBinding binding, long deadline, boolean refresh) {
    this.vault = state.id;
    this.revision = state.revision;
    this.pubkey = pubkey;
    this.binding = binding;
    this.deadline = deadline;
    this.refresh = refresh;
  }

  String refreshReview() {
    return "Identity:\n" + pubkey + "\n\nSigner peer:\n" + binding.peer +
      "\n\nUse exactly these signer relays:\n" + String.join("\n", binding.relays) +
      "\n\nAccount data and the selected signing method remain unchanged. Pending requests will be cancelled.";
  }

  String connectReview(State current) {
    Record existing = recordFor(current, pubkey);
    return "Connect and use this signer for identity:\n" + pubkey + "\n\nSigner peer:\n" + binding.peer +
      "\n\nSigner relays:\n" + String.join("\n", binding.relays) +
      (existing != null && existing.key != null ? "\n\nThe local key remains available." : "\n\nNo local key is stored for this identity.");
  }

  private static Record recordFor(State state, String pubkey) {
    return state.records.stream().filter(value -> value.pubkey.equals(pubkey)).findFirst().orElse(null);
  }

  private static boolean matchesRefresh(State state, Record existing, String pubkey, NativeRemoteBinding binding) {
    return state.selected.equals(pubkey) && existing != null && existing.remote != null &&
      existing.remote.peer.equals(binding.peer) && existing.remote.client.publicKey().equals(binding.client.publicKey());
  }

  static final class Registry {
    private final NativeVault records;
    private final LongSupplier clock;
    private final BooleanSupplier busy;
    private NativeConnectionCandidate candidate;

    Registry(NativeVault records, LongSupplier clock, BooleanSupplier busy) {
      this.records = records;
      this.clock = clock;
      this.busy = busy;
    }

    private void requireVaultMonitor() {
      if (!Thread.holdsLock(records)) throw new IllegalStateException("Native vault monitor required");
    }

    boolean pending() {
      requireVaultMonitor();
      return candidate != null;
    }

    String prepare(State current, String pubkey, NativeRemoteBinding binding, long deadline, boolean refresh) {
      requireVaultMonitor();
      try {
        long now = clock.getAsLong();
        if (now < 0 || deadline <= now || deadline - now > 120_000L) throw new Error("SIGNER_EXPIRED");
        if (!NativeSigningKey.validPublicKey(pubkey)) throw new Error("SIGNER_RESPONSE_INVALID");
        if (busy.getAsBoolean()) throw new Error("NOT_READY");
        Record existing = recordFor(current, pubkey);
        if (refresh) {
          if (!matchesRefresh(current, existing, pubkey, binding)) throw new Error("AUTHORIZATION_DENIED");
          if (existing.remote.relays.equals(binding.relays)) throw new Error("SIGNER_UNSUPPORTED");
        } else if (existing != null && existing.remote != null) throw new Error("SIGNER_ALREADY_CONNECTED");
        if (existing == null && current.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
        candidate = new NativeConnectionCandidate(current, pubkey, binding, deadline, refresh);
        return new JSONObject().put("handle", candidate.handle).put("pubkey", pubkey).toString();
      } catch (Error failure) { throw failure; }
      catch (Exception failure) { throw new Error("STORAGE_FAILURE"); }
    }

    NativeConnectionCandidate current(String handle, String vault, long revision, boolean refresh) {
      requireVaultMonitor();
      if (candidate != null && clock.getAsLong() >= candidate.deadline) clear();
      NativeConnectionCandidate value = candidate;
      if (value == null || !value.handle.equals(handle) || !value.vault.equals(vault) || value.revision != revision || value.refresh != refresh) {
        throw new Error("SIGNER_EXPIRED");
      }
      return value;
    }

    String commit(State state, String handle, String vault, long revision, boolean refresh) {
      NativeConnectionCandidate pending = current(handle, vault, revision, refresh);
      NativeRemoteBinding previous = null;
      try {
        Record existing = recordFor(state, pending.pubkey);
        if (refresh) {
          if (!matchesRefresh(state, existing, pending.pubkey, pending.binding)) throw new Error("AUTHORIZATION_DENIED");
          previous = existing.remote;
        } else if (existing != null && existing.remote != null) throw new Error("SIGNER_ALREADY_CONNECTED");
        if (existing == null && state.records.size() >= MAX_IDENTITIES) throw new Error("LIMIT_REACHED");
        advance(state);
        if (existing == null) {
          existing = new Record(pending.pubkey, null, pending.binding, timestamp(), 2, NIP46);
          state.records.add(existing);
        } else {
          existing.remote = pending.binding;
          if (!refresh) existing.method = NIP46;
        }
        candidate = null;
        state.selected = existing.pubkey;
        records.persist(state, false);
        return NativeVaultMetadata.snapshot(state);
      } finally { if (previous != null) previous.close(); }
    }

    void cancel(String handle, boolean refresh) {
      requireVaultMonitor();
      if (candidate != null && candidate.handle.equals(handle)) {
        if (candidate.refresh != refresh) throw new Error("AUTHORIZATION_DENIED");
        clear();
      }
    }

    void clear() {
      requireVaultMonitor();
      if (candidate != null) {
        candidate.binding.close();
        candidate = null;
      }
    }
  }
}
