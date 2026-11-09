package org.nostrocket.hypergolic.signercore;

import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Native composition only. Immutable metadata; never a key or signing permit. */
public final class NativeLocalVaultLease {
  public final String account, vaultId;
  public final long vaultRevision, runtimeEpoch;
  private final BooleanSupplier current;
  private final AtomicBoolean retired = new AtomicBoolean();
  private static WeakReference<Supplier<NativeLocalVaultLease>> provider = new WeakReference<>(null);
  private NativeLocalVaultLease(String account, String vaultId, long revision, long epoch, BooleanSupplier current) {
    this.account=account; this.vaultId=vaultId; vaultRevision=revision; runtimeEpoch=epoch; this.current=current;
  }
  static NativeLocalVaultLease issue(String account, String vaultId, long revision, long epoch, BooleanSupplier current) {
    return new NativeLocalVaultLease(account,vaultId,revision,epoch,current);
  }
  static synchronized void install(Supplier<NativeLocalVaultLease> value) {
    Supplier<NativeLocalVaultLease> previous=provider.get();
    if(previous!=null && previous!=value) throw new IllegalStateException("Native vault owner already installed");
    provider=new WeakReference<>(value);
  }
  /** Not exported by an Expo function. The installed native owner derives every field. */
  public static NativeLocalVaultLease capture() {
    Supplier<NativeLocalVaultLease> owner;
    synchronized(NativeLocalVaultLease.class) { owner=provider.get(); }
    if(owner==null) throw new IllegalStateException("Native local vault unavailable");
    NativeLocalVaultLease value=owner.get();
    if(value==null || !value.isCurrent()) throw new IllegalStateException("Native local vault unavailable");
    return value;
  }
  public boolean isCurrent() {
    if(retired.get()) return false;
    try { if(current.getAsBoolean() && !retired.get()) return true; }
    catch(RuntimeException failure) { /* Native denial permanently retires this exact lease. */ }
    retire(); return false;
  }
  boolean retired() { return retired.get(); }
  void retire() { retired.set(true); }
}
