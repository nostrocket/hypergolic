package org.nostrocket.hypergolic.host;

import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;

/** Private no-backup metadata. Rename and directory fsync precede the ledger's exact readback. */
final class UploadRecoveryFileStore implements UploadRecoveryLedger.Store {
  private final File root, file, pending;
  UploadRecoveryFileStore(File noBackupDirectory) throws IOException {
    if (noBackupDirectory == null) throw new IOException("Recovery directory unavailable");
    root = new File(noBackupDirectory, "UploadRecovery-v1"); file = new File(root, "ledger.bin"); pending = new File(root, ".pending");
    try {
      if (stat(root) == null) { Os.mkdir(root.getPath(), 0700); sync(noBackupDirectory); }
      check(root, true);
      if (stat(pending) != null) { check(pending, false); Os.remove(pending.getPath()); sync(root); }
    } catch (ErrnoException failed) { throw new IOException("Recovery directory unavailable", failed); }
  }
  private static StructStat stat(File path) throws ErrnoException {
    try { return Os.lstat(path.getPath()); }
    catch (ErrnoException failed) { if (failed.errno == OsConstants.ENOENT) return null; throw failed; }
  }
  private static void check(File path, boolean directory) throws IOException, ErrnoException {
    StructStat info = stat(path);
    if (info == null || info.st_uid != Process.myUid() || (info.st_mode & OsConstants.S_IFMT) != (directory ? OsConstants.S_IFDIR : OsConstants.S_IFREG) ||
      (info.st_mode & 0777) != (directory ? 0700 : 0600) || !directory && info.st_nlink != 1) throw new IOException("Invalid recovery file");
  }
  private static void sync(File directory) throws ErrnoException {
    FileDescriptor fd = Os.open(directory.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
    try { if ((Os.fstat(fd).st_mode & OsConstants.S_IFMT) != OsConstants.S_IFDIR) throw new ErrnoException("directory", OsConstants.ENOTDIR); Os.fsync(fd); } finally { Os.close(fd); }
  }
  @Override public byte[] read() throws IOException {
    FileDescriptor fd = null;
    try {
      check(root, true); if (stat(file) == null) return null; check(file, false);
      fd = Os.open(file.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
      StructStat info = Os.fstat(fd);
      if ((info.st_mode & OsConstants.S_IFMT) != OsConstants.S_IFREG || info.st_nlink != 1 || info.st_size < 0 || info.st_size > UploadRecoveryLedger.MAX_STORE_BYTES) throw new IOException("Recovery file limit");
      var bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
      for (;;) { int count = Os.read(fd, buffer, 0, buffer.length); if (count == 0) return bytes.toByteArray();
        if (bytes.size() + count > UploadRecoveryLedger.MAX_STORE_BYTES) throw new IOException("Recovery file limit"); bytes.write(buffer, 0, count); }
    } catch (ErrnoException failed) { throw new IOException("Recovery read unavailable", failed); }
    finally { if (fd != null) try { Os.close(fd); } catch (ErrnoException failed) { throw new IOException("Recovery close unavailable", failed); } }
  }
  @Override public void write(byte[] value) throws IOException {
    FileDescriptor fd = null; boolean temporary = false;
    try {
      if (value == null || value.length > UploadRecoveryLedger.MAX_STORE_BYTES) throw new IOException("Recovery file limit");
      check(root, true); if (stat(file) != null) check(file, false);
      fd = Os.open(pending.getPath(), OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0600); temporary = true;
      check(pending, false);
      for (int offset = 0; offset < value.length;) { int count = Os.write(fd, value, offset, value.length - offset); if (count <= 0) throw new IOException("Recovery write unavailable"); offset += count; }
      Os.fsync(fd); FileDescriptor closing = fd; fd = null; Os.close(closing);
      Os.rename(pending.getPath(), file.getPath()); temporary = false; check(file, false); sync(root);
    } catch (ErrnoException failed) { throw new IOException("Recovery write unavailable", failed); }
    finally {
      if (fd != null) try { Os.close(fd); } catch (ErrnoException ignored) { /* Ledger remains failed closed. */ }
      if (temporary) try { Os.remove(pending.getPath()); } catch (ErrnoException ignored) { /* Private metadata is cleaned on next open. */ }
    }
  }
}
