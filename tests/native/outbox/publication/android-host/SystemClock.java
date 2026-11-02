package android.os;

/** Host monotonic clock only; does not model Android suspend or device lifecycle. */
public final class SystemClock {
  private SystemClock() {}
  public static long elapsedRealtime() {
    return java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime());
  }
}
