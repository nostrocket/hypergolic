package android.system;

public final class OsConstants {
  public static final int O_RDONLY = 1, O_CLOEXEC = 4, O_NOFOLLOW = 8;

  public static boolean S_ISDIR(int mode) {
    return mode == 1;
  }
}
