package org.nostrocket.hypergolic.host;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.UUID;

/** Actual ledger codec/state owner; memory-store fault injection is not native disk or network acceptance. */
public final class UploadRecoveryProof {
  private static int checks;
  private static final String ID = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", SERVER = "https://files.example.com";
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Recovery check " + checks); }
  private interface Action { void run() throws IOException; }
  private static void denied(Action action) throws IOException {
    try { action.run(); throw new AssertionError("Unavailable recovery accepted"); } catch (IOException expected) { check(true); }
  }
  private static final class Memory implements UploadRecoveryLedger.Store {
    byte[] bytes; boolean failWrite, loseWrite; int writes;
    public byte[] read() { return bytes == null ? null : bytes.clone(); }
    public void write(byte[] value) throws IOException { writes++; if (failWrite) throw new IOException("Injected store failure"); if (!loseWrite) bytes = value.clone(); }
  }
  private static UploadRecoveryLedger.Entry entry(int number) {
    return new UploadRecoveryLedger.Entry(new UUID(0, number).toString(), ID, ID, "upload-lab-λ", SERVER,
      String.format(java.util.Locale.ROOT, "%064x", number), "image/png", 71, UploadRecoveryLedger.State.UNKNOWN);
  }
  public static void main(String[] args) throws Exception {
    var memory = new Memory(); var ledger = new UploadRecoveryLedger(memory); var first = entry(1);
    check(ledger.list(ID).isEmpty()); check(ledger.start(first)); check(memory.writes == 1);
    check(ledger.blocks(ID, SERVER, first.sha256())); check(!ledger.start(entry(1))); check(memory.writes == 1);
    var duplicate = new UploadRecoveryLedger.Entry(entry(2).uploadId(), ID, ID, "other-caller", SERVER, first.sha256(), "image/png", 71, UploadRecoveryLedger.State.UNKNOWN);
    check(!ledger.start(duplicate)); check(!ledger.blocks(ID, "https://other.example.com", first.sha256()));
    String other = "00".repeat(32); check(!ledger.blocks(other, SERVER, first.sha256()));
    var restarted = new UploadRecoveryLedger(memory); check(restarted.list(ID).equals(ledger.list(ID))); check(!restarted.start(duplicate));
    check(!restarted.settle(duplicate, UploadRecoveryLedger.State.ABSENT)); check(!restarted.settle(first, UploadRecoveryLedger.State.UNKNOWN));
    check(restarted.settle(first, UploadRecoveryLedger.State.ABSENT)); check(!restarted.settle(first, UploadRecoveryLedger.State.PRESENT));
    check(!restarted.blocks(ID, SERVER, first.sha256())); check(restarted.start(duplicate));
    var fullStore = new Memory(); var full = new UploadRecoveryLedger(fullStore);
    for (int number = 1; number <= UploadRecoveryLedger.MAX_RECORDS; number++) check(full.start(entry(number)));
    check(!full.start(entry(33))); check(new UploadRecoveryLedger(fullStore).list(ID).size() == 32);
    check(full.settle(entry(1), UploadRecoveryLedger.State.CONFIRMED)); check(full.start(entry(33)));
    check(full.list(ID).size() == 32); check(full.list(ID).stream().noneMatch(row -> row.uploadId().equals(entry(1).uploadId())));
    check(full.list(ID).stream().anyMatch(row -> row.uploadId().equals(entry(2).uploadId())));
    var failureStore = new Memory(); var failed = new UploadRecoveryLedger(failureStore); failureStore.failWrite = true;
    denied(() -> failed.start(first)); failureStore.failWrite = false; denied(() -> failed.start(first)); denied(() -> failed.list(ID));
    var lostStore = new Memory(); var lost = new UploadRecoveryLedger(lostStore); lostStore.loseWrite = true; denied(() -> lost.start(first));
    var fixture = new LinkedHashMap<String, UploadRecoveryLedger.Entry>(); fixture.put(first.uploadId(), first);
    byte[] encoded = UploadRecoveryLedger.encode(fixture); check(UploadRecoveryLedger.decode(encoded).equals(fixture));
    for (int length = 0; length < encoded.length; length++) {
      byte[] truncated = Arrays.copyOf(encoded, length); denied(() -> UploadRecoveryLedger.decode(truncated));
    }
    for (int index = 0; index < encoded.length; index++) {
      byte[] corrupt = encoded.clone(); corrupt[index] ^= 1; denied(() -> UploadRecoveryLedger.decode(corrupt));
    }
    var corruptStore = new Memory(); corruptStore.bytes = new byte[44]; denied(() -> new UploadRecoveryLedger(corruptStore));
    Files.write(Path.of(args[0], "java-recovery.bin"), encoded);
    if (args.length > 1) check(UploadRecoveryLedger.decode(Files.readAllBytes(Path.of(args[1]))).equals(fixture));
    System.out.println("{\"language\":\"Java\",\"uploadRecoveryChecks\":"+checks+",\"failed\":0,\"scope\":\"native ledger core; injected memory store, no durable disk or network proof\"}");
  }
}
