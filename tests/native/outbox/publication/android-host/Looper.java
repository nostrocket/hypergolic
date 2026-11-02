package android.os;

/** Host initialization adapter. UI delivery is deliberately outside this proof. */
public final class Looper {
  private static final Looper MAIN = new Looper();
  private Looper() {}
  public static Looper getMainLooper() { return MAIN; }
  public static Looper myLooper() { return MAIN; }
}
