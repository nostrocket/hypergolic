package android.os;

/** Explicit host clock port; no Android runtime or wall-clock timing claim. */
public final class SystemClock {
  public static long now = 100;
  public static int reads;
  public static Runnable beforeRead;
  private SystemClock() {}
  public static long elapsedRealtime() {
    reads++;
    if (beforeRead != null) beforeRead.run();
    return now;
  }
}
