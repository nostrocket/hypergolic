package android.os;
public final class SystemClock {
  public static volatile long time=1000;
  private SystemClock(){}
  public static long elapsedRealtime(){return time;}
  public static long uptimeMillis(){return time;}
}
