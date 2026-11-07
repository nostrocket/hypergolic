package org.nostrocket.hypergolic.host;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;

public final class LiveMP3ResponseProof {
  private static int checks;
  private static final String OK = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n";
  private static void check(boolean value) { if (!value) throw new AssertionError(); checks++; }
  private interface Action { void run() throws Exception; }
  private static void denied(Action action) throws Exception {
    try { action.run(); throw new AssertionError("Expected rejection"); } catch (IOException expected) { checks++; }
  }
  private static byte[] read(String wire) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    LiveMP3Response.read(new ByteArrayInputStream(wire.getBytes(StandardCharsets.US_ASCII)), new LiveMP3Budget(), () -> {}, (bytes, count) -> out.write(bytes, 0, count));
    return out.toByteArray();
  }
  public static void main(String[] args) throws Exception {
    check(Arrays.equals(read(OK+"\r\nabc"), new byte[]{97,98,99}));
    check(Arrays.equals(read(OK+"Content-Length: 3\r\n\r\nabc"), new byte[]{97,98,99}));
    check(Arrays.equals(read(OK+"Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\nX-Report: fine\r\n\r\n"), new byte[]{97,98,99}));
    for (String framing : new String[]{"Content-Length: 3\r\nTransfer-Encoding: chunked", "Content-Length: +3", "Content-Length: 33554433", "Content-Length: 3\r\nContent-Length: 3", "Transfer-Encoding: gzip", "Content-Encoding: gzip", "icy-metaint: 1", "Content-Range: bytes 0-1/2"}) {
      denied(() -> read(OK+framing+"\r\n\r\nabc"));
    }
    for (String body : new String[]{"1\na\r\n0\r\n\r\n", "80000000\r\n", "1;foo=bar\r\na\r\n0\r\n\r\n", "1\r\naXX", "0\r\nContent-Type: text/html\r\n\r\n", "0\r\n\r\nx"}) denied(() -> read(OK+"Transfer-Encoding: chunked\r\n\r\n"+body));
    denied(() -> read(OK+"Content-Length: 4\r\n\r\nabc"));
    denied(() -> read(OK+"Content-Length: 2\r\n\r\nabc"));
    denied(() -> read("HTTP/1.1 200 OK\r\nContent-Type: audio/ogg\r\n\r\nabc"));
    denied(() -> read(OK+"X-Long: "+"a".repeat(8192)+"\r\n\r\n"));
    try { read("HTTP/1.1 302 Found\r\nLocation: https://media.example.org/live\r\n\r\n"); throw new AssertionError(); }
    catch (PublishedHttpsResponseReader.ResourceRedirect redirect) { check(redirect.location.equals("https://media.example.org/live")); }
    AtomicLong now = new AtomicLong(0); LiveMP3Budget budget = new LiveMP3Budget(now::get, 4, 100);
    budget.charge(4);check(budget.received()==4);denied(() -> budget.charge(1));
    budget.markOutput();now.set(50);budget.beginAttempt();check(budget.received()==4);now.set(100);denied(budget::check);
    now.set(0);LiveMP3Budget startup = new LiveMP3Budget(now::get,4,20000);startup.beginAttempt();now.set(15000);denied(startup::check);
    now.set(0);LiveMP3Budget retired = new LiveMP3Budget(now::get,4,20000);retired.cancel();denied(retired::beginAttempt);
    ByteArrayOutputStream received = new ByteArrayOutputStream();
    denied(() -> LiveMP3Response.read(new ByteArrayInputStream((OK+"\r\nabc").getBytes(StandardCharsets.US_ASCII)),new LiveMP3Budget(),()->{throw new IOException("revoked");},(bytes, count) -> received.write(bytes, 0, count)));
    check(received.size()==0);
    // Independent literal cap, not each implementation's own constant.
    check(LiveMP3Budget.MAX_BYTES==32*1024*1024&&LiveMP3Budget.SESSION_MS==15*60*1000L);
    LiveMP3Budget exactCap = new LiveMP3Budget(); exactCap.markOutput();exactCap.charge(32*1024*1024);
    check(exactCap.received()==32*1024*1024);denied(()->exactCap.charge(1));
    System.out.println("LiveMP3ResponseProof: "+checks+" checks passed");
  }
}
