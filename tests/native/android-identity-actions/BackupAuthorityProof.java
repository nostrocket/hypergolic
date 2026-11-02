package org.nostrocket.hypergolic.identityowner;

import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Owning production authority, explicit test inventory/auth/clock; no simulated OS-auth claim. */
public final class BackupAuthorityProof {
  private static int assertions;
  private static String key(int value) { return String.format("%064x", value); }
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Backup authority assertion " + assertions); }
  private static void denied(Runnable operation) {
    assertions++;
    try { operation.run(); } catch (DeletionAuthority.Denied expected) { return; }
    throw new AssertionError("Expected backup denial at " + assertions);
  }
  private static final class Rig {
    long time;
    int tokens;
    boolean readFails;
    DeletionAuthority.Inventory inventory = inventory(1, 1);
    final DeletionAuthority authority = new DeletionAuthority(() -> { if (readFails) throw new IllegalStateException(); return inventory; }, () -> time, () -> key(++tokens));
    final String session;
    Rig() { authority.activate(); authority.updateForeground(true); session = authority.beginSettings(key(1), 1); }
    DeletionAuthority.Attempt begin() { return authority.beginBackup(session, key(1), key(1), 1); }
    DeletionAuthority.BackupLease approve() { return authority.completeBackup(begin(), true); }
  }
  private static DeletionAuthority.Inventory inventory(long revision, int selected) {
    return new DeletionAuthority.Inventory("backup_test_vault_0123", revision, key(selected), key(10), Map.of(key(1), key(11), key(2), key(12)));
  }
  private static char[] secret() { return new char[63]; }
  private static void exactIdentityAndPurpose() {
    Rig r = new Rig();
    denied(() -> r.authority.beginBackup(r.session, key(2), key(1), 1));
    denied(() -> r.authority.beginBackup(r.session, key(1), key(2), 1));
    denied(() -> r.authority.beginBackup(r.session, key(1), key(1), 2));
    denied(() -> r.authority.beginBackup(key(9), key(1), key(1), 1));
    DeletionAuthority.Attempt deletion = r.authority.begin(r.session, key(2), key(1), 1);
    denied(() -> r.authority.completeBackup(deletion, true));
    denied(() -> r.authority.complete(deletion, true));
    DeletionAuthority.Attempt backup = r.begin();
    denied(() -> r.authority.complete(backup, true));
    denied(() -> r.authority.completeBackup(backup, true));
    DeletionAuthority.BackupLease lease = r.approve();
    denied(r::begin);
    denied(() -> r.authority.begin(r.session, key(2), key(1), 1));
    char[] result = r.authority.readBackup(lease, (target, digest) -> {
      check(target.equals(key(1)) && digest.equals(key(11))); return secret();
    });
    check(result.length == 63 && r.authority.canReveal(lease));
    denied(() -> r.authority.readBackup(lease, (target, digest) -> secret()));
    r.authority.closeBackup(lease); check(!r.authority.canReveal(lease));
    Rig single = new Rig();
    single.inventory = new DeletionAuthority.Inventory("backup_test_vault_0123", 1, key(1), key(10), Map.of(key(1), key(11)));
    String session = single.authority.beginSettings(key(1), 1);
    check(single.authority.canPresent(single.authority.beginBackup(session, key(1), key(1), 1)));
  }
  private static void cancellationAndExpiry() {
    for (int boundary = 0; boundary < 3; boundary++) for (int cause = 0; cause < 6; cause++) {
      Rig r = new Rig(); DeletionAuthority.Attempt attempt = r.begin();
      DeletionAuthority.BackupLease lease = boundary > 0 ? r.authority.completeBackup(attempt, true) : null;
      if (boundary > 1) r.authority.readBackup(lease, (target, digest) -> secret());
      switch (cause) {
        case 0: r.authority.cancel(r.session); break;
        case 1: r.authority.endSettings(r.session); break;
        case 2: r.authority.updateForeground(false); r.authority.updateForeground(true); break;
        case 3: r.authority.retire(); break;
        case 4: r.authority.vaultWillMutate(); break;
        default: r.time += DeletionAuthority.REVEAL_MILLIS;
      }
      check(!r.authority.canPresent(attempt));
      if (boundary == 0) denied(() -> r.authority.completeBackup(attempt, true));
      else {
        check(!r.authority.canReveal(lease));
        denied(() -> r.authority.readBackup(lease, (target, digest) -> { throw new AssertionError("Read revoked secret"); }));
      }
    }
    Rig r = new Rig(); DeletionAuthority.Attempt old = r.begin(); r.authority.cancel(r.session);
    DeletionAuthority.BackupLease current = r.approve(); r.authority.cancelAttempt(old);
    check(r.authority.canReveal(current));
    Rig foreign = new Rig(); check(!foreign.authority.canReveal(current));
    DeletionAuthority.BackupLease next = foreign.approve();
    foreign.authority.closeBackup(current); check(foreign.authority.canReveal(next));
    r.authority.closeBackup(current); current = r.approve();
    check(r.authority.canReveal(current));
  }
  private static void changedRecordsAndSlowRead() {
    Rig r = new Rig(); DeletionAuthority.Attempt attempt = r.begin(); r.inventory = inventory(2, 1);
    denied(() -> r.authority.completeBackup(attempt, true));
    Rig beforeRead = new Rig(); DeletionAuthority.BackupLease lease = beforeRead.approve(); beforeRead.inventory = inventory(2, 2);
    denied(() -> beforeRead.authority.readBackup(lease, (target, digest) -> { throw new AssertionError("Read changed secret"); }));
    for (int failure = 0; failure < 3; failure++) {
      Rig afterRead = new Rig(); DeletionAuthority.BackupLease active = afterRead.approve();
      char[] output = secret(); Arrays.fill(output, 'x'); final int kind = failure;
      denied(() -> afterRead.authority.readBackup(active, (target, digest) -> {
        if (kind == 0) afterRead.inventory = inventory(2, 2);
        else if (kind == 1) afterRead.time += DeletionAuthority.REVEAL_MILLIS;
        else afterRead.authority.cancel(afterRead.session);
        return output;
      }));
      check(new String(output).equals("\0".repeat(63)));
      check(!afterRead.authority.canReveal(active));
    }
    Rig malformed = new Rig(); DeletionAuthority.BackupLease active = malformed.approve(); char[] bad = {'x'};
    denied(() -> malformed.authority.readBackup(active, (target, digest) -> bad)); check(bad[0] == 0);
    Rig failed = new Rig(); DeletionAuthority.BackupLease reserved = failed.approve(); AtomicInteger reads = new AtomicInteger();
    denied(() -> failed.authority.readBackup(reserved, (target, digest) -> { reads.incrementAndGet(); throw new IllegalStateException(); }));
    denied(() -> failed.authority.readBackup(reserved, (target, digest) -> secret())); check(reads.get() == 1);
    Rig unreadable = new Rig(); DeletionAuthority.BackupLease readLease = unreadable.approve(); unreadable.readFails = true;
    denied(() -> unreadable.authority.readBackup(readLease, (target, digest) -> secret()));
    unreadable.readFails = false; check(!unreadable.authority.canReveal(readLease));
    denied(() -> unreadable.authority.readBackup(readLease, (target, digest) -> secret()));
    Rig rejected = new Rig(); DeletionAuthority.Attempt deniedAttempt = rejected.begin();
    denied(() -> rejected.authority.completeBackup(deniedAttempt, false));
    denied(() -> rejected.authority.completeBackup(deniedAttempt, true));
  }
  public static void main(String[] args) {
    exactIdentityAndPurpose(); cancellationAndExpiry(); changedRecordsAndSlowRead();
    System.out.println("{\"status\":\"passed\",\"assertions\":" + assertions + "}");
  }
}
