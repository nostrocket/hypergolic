package org.nostrocket.hypergolic.signercore;

import java.util.UUID;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;

/** One native purpose, base record revision and original deadline; never a reusable review grant. */
final class NativeConnectionCandidate {
    final String handle = UUID.randomUUID().toString();
    final String vault, pubkey;
    final long revision, deadline;
    final boolean refresh;
    final NativeRemoteBinding binding;
    NativeConnectionCandidate(State state, String pubkey, NativeRemoteBinding binding, long deadline, boolean refresh) {
      this.vault = state.id;
      this.revision = state.revision;
      this.pubkey = pubkey;
      this.binding = binding;
      this.deadline = deadline;
      this.refresh = refresh;
    }
  }
