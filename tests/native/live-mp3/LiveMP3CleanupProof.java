package org.nostrocket.hypergolic.host;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
public final class LiveMP3CleanupProof {
  private static int checks;
  private static void check(boolean value) { if (!value) throw new AssertionError(); checks++; }
  public static void main(String[] args) {
    AtomicInteger detach=new AtomicInteger(),abandon=new AtomicInteger(),release=new AtomicInteger();
    LiveMP3Cleanup failed=new LiveMP3Cleanup();
    boolean first=failed.close(()->{detach.incrementAndGet();throw new IOException("listener failure");},abandon::incrementAndGet,()->{release.incrementAndGet();throw new IOException("release failure");});
    check(!first);check(detach.get()==1);check(abandon.get()==1);check(release.get()==1);
    boolean second=failed.close(()->{throw new AssertionError("Must not retry or invent disposal success");});
    check(!second);check(release.get()==1);
    LiveMP3Cleanup success=new LiveMP3Cleanup();AtomicInteger once=new AtomicInteger();
    check(success.close(once::incrementAndGet));check(success.close(once::incrementAndGet));check(once.get()==1);
    System.out.println("LiveMP3CleanupProof: "+checks+" checks passed");
  }
}
