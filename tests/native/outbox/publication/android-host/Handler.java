package android.os;

/** Fails if a proof starts relying on a fabricated Android UI queue. */
public final class Handler {
  public Handler(Looper looper) {
    if (looper != Looper.getMainLooper()) throw new AssertionError("Unexpected looper");
  }
  public boolean post(Runnable work) { throw new AssertionError("UI queue outside owner proof"); }
  public boolean postDelayed(Runnable work, long delay) { throw new AssertionError("UI timer outside owner proof"); }
}
