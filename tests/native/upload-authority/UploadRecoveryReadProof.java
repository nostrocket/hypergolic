package org.nostrocket.hypergolic.host;

import java.util.concurrent.atomic.AtomicLong;

public final class UploadRecoveryReadProof {
  private static int checks;
  private static void check(boolean condition) { checks++; if (!condition) throw new AssertionError("Recovery read check " + checks); }
  private static final class Memory implements UploadRecoveryLedger.Store {
    private byte[] value;
    public byte[] read() { return value == null ? null : value.clone(); }
    public void write(byte[] bytes) { value = bytes.clone(); }
  }
  private static UploadRecoveryLedger.Entry row(int id) {
    return new UploadRecoveryLedger.Entry(String.format("00000000-0000-0000-0000-%012d", id), "a".repeat(64), "b".repeat(64), "app", "https://files.example.com",
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", "text/plain", 3, UploadRecoveryLedger.State.UNKNOWN);
  }
  public static void main(String[] ignored) throws Exception {
    var time = new AtomicLong(1); var authority = new UploadRecoveryReadAuthority(time::get);
    var ledger = new UploadRecoveryLedger(new Memory()); var row = row(1); check(ledger.start(row));
    check(authority.identity() == null); check(authority.capture(row) == null);
    check(authority.register("realm1", row.identity())); authority.foreground(true);
    check(row.identity().equals(authority.identity())); var first = authority.capture(row); check(first != null); check(authority.live(first)); check(authority.capture(row) == null);
    check(authority.finish(first, 200, new byte[]{1,2,4}, ledger) == UploadRecoveryLedger.State.UNKNOWN); check(ledger.blocks(row.identity(), row.destination(), row.sha256())); check(!authority.live(first));
    var second = authority.capture(row); check(second != null);
    check(authority.finish(second, 200, new byte[]{1,2,3}, ledger) == UploadRecoveryLedger.State.PRESENT); check(!ledger.blocks(row.identity(), row.destination(), row.sha256()));
    check(authority.finish(second, 404, new byte[0], ledger) == UploadRecoveryLedger.State.UNKNOWN);
    var absent = row(2); check(ledger.start(absent)); var read = authority.capture(absent); check(read != null);
    authority.foreground(false); authority.foreground(true); check(!authority.live(read));
    check(authority.finish(read, 404, new byte[0], ledger) == UploadRecoveryLedger.State.UNKNOWN); check(ledger.blocks(absent.identity(), absent.destination(), absent.sha256()));
    read = authority.capture(absent); check(read != null); authority.revoke("realm1"); check(!authority.live(read)); check(authority.identity() == null);
    check(authority.register("realm2", row.identity())); read = authority.capture(absent); check(read != null);
    check(authority.register("realm3", "c".repeat(64))); check(!authority.live(read)); check(authority.capture(absent) == null); check(authority.identity().equals("c".repeat(64)));
    authority.revoke("realm3"); check(authority.register("realm4", row.identity())); read = authority.capture(absent); check(read != null);
    check(authority.finish(read, 404, new byte[]{4,0,4}, ledger) == UploadRecoveryLedger.State.ABSENT);
    var fresh = row(3); check(ledger.start(fresh)); read = authority.capture(fresh); check(read != null);
    time.set(60_001); check(!authority.live(read)); check(authority.finish(read, 404, new byte[0], ledger) == UploadRecoveryLedger.State.UNKNOWN);
    read = authority.capture(fresh); check(read != null); authority.cancel(read); check(!authority.live(read));
    read = authority.capture(fresh); check(read != null); time.set(0); check(!authority.live(read)); time.set(100_000); check(authority.identity() == null); check(authority.capture(fresh) == null);
    System.out.println("{\"language\":\"Java\",\"uploadRecoveryReadChecks\":"+checks+",\"failed\":0,\"scope\":\"native read authority and injected store; no HTTP or app journey proof\"}");
  }
}
