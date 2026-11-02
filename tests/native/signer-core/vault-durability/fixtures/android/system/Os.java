package android.system;
import java.io.*;
import java.util.*;

public final class Os {
  public static final List<String> events = new ArrayList<>();
  public static String failDirectory, failCloseDirectory;
  public static boolean wrongType;
  private static final Map<FileDescriptor, String> paths = new IdentityHashMap<>();

  public static FileDescriptor open(String p, int f, int m) throws IOException {
    if (!new File(p).isDirectory())
      throw new IOException("not directory");
    FileDescriptor d = new FileDescriptor();
    paths.put(d, p);
    events.add("open-directory:" + p);
    return d;
  }

  public static StructStat fstat(FileDescriptor d) {
    return new StructStat(wrongType ? 0 : 1);
  }

  public static void fsync(FileDescriptor d) throws IOException {
    String p = paths.get(d);
    events.add("sync-directory:" + p);
    if (p.equals(failDirectory))
      throw new IOException("injected directory sync failure");
  }

  public static void close(FileDescriptor d) throws IOException {
    String p = paths.remove(d);
    events.add("close-directory:" + p);
    if (p.equals(failCloseDirectory))
      throw new IOException("injected directory close failure");
  }
}
