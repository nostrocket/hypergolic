package android.util;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Explicit host double for AOSP commit 1cdfff5's relevant start/finish/fail/read semantics. */
public final class AtomicFile {
  public static boolean swallowSyncFailure, failRename, failWrite, failRead;
  public static int swallowedSyncFailures, finishes, failures;
  public static final List<String> events = new ArrayList<>();
  private final File base, next, backup;

  public AtomicFile(File f) {
    base = f;
    next = new File(f.getPath() + ".new");
    backup = new File(f.getPath() + ".bak");
  }

  public File getBaseFile() {
    return base;
  }

  public FileOutputStream startWrite() throws IOException {
    events.add("start");
    return new FileOutputStream(next) {
      public void write(byte[] b) throws IOException {
        if (failWrite) {
          super.write(b, 0, Math.min(3, b.length));
          throw new IOException("injected partial write");
        }
        super.write(b);
      }
    };
  }

  public void finishWrite(FileOutputStream out) {
    events.add("finish");
    finishes++;
    try {
      if (swallowSyncFailure)
        throw new IOException("injected AOSP internal sync failure");
      out.getFD().sync();
    } catch (IOException ignored) {
      swallowedSyncFailures++;
    }
    try {
      out.close();
    } catch (IOException ignored) {
    }
    if (!failRename) {
      try {
        Files.move(next.toPath(), base.toPath(), StandardCopyOption.REPLACE_EXISTING,
            StandardCopyOption.ATOMIC_MOVE);
      } catch (IOException ignored) {
      }
    }
  }

  public void failWrite(FileOutputStream out) {
    events.add("fail");
    failures++;
    try {
      out.close();
    } catch (IOException ignored) {
    }
    next.delete();
  }

  public FileInputStream openRead() throws IOException {
    events.add("read");
    if (failRead)
      throw new IOException("injected read error");
    if (backup.exists())
      Files.move(backup.toPath(), base.toPath(), StandardCopyOption.REPLACE_EXISTING);
    if (next.exists() && base.exists())
      next.delete();
    return new FileInputStream(base);
  }

  public static void reset() {
    swallowSyncFailure = false;
    failRename = false;
    failWrite = false;
    failRead = false;
    swallowedSyncFailures = 0;
    finishes = 0;
    failures = 0;
    events.clear();
  }
}
