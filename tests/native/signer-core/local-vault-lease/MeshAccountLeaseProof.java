package org.nostrocket.hypergolic.mesh;

import java.util.function.BooleanSupplier;
import org.nostrocket.hypergolic.signercore.NativeLocalVaultLease;

public final class MeshAccountLeaseProof {
  private MeshAccountLeaseProof() {}
  public static BooleanSupplier adapt(NativeLocalVaultLease source) {
    NativeMeshIdentityStore.AccountLease lease = NativeMeshIdentityStore.AccountLease.selectedLocal(source);
    if (!source.account.equals(lease.account) || source.runtimeEpoch != lease.epoch ||
        source.vaultRevision != lease.vaultRevision || !lease.isCurrent()) {
      throw new AssertionError("Mesh adapter must retain exact current native owner metadata");
    }
    return lease::isCurrent;
  }
  public static void rejects(NativeLocalVaultLease source) {
    try {
      adapt(source);
      throw new AssertionError("Mesh adapter accepted an absent or retired native lease");
    } catch (NativeMeshIdentityStore.Failure expected) {
      // Failure is the store's own denial, not a fixture's substitute current predicate.
    }
  }
}
