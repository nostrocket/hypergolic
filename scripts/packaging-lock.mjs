import { DatabaseSync } from 'node:sqlite';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** SQLite owns cross-process exclusion. The PID file also protects older packaging tools. */
export async function acquirePackagingLock(lock) {
  const guard = new DatabaseSync(path.join(path.dirname(lock), '..', '.packaging-lock.sqlite'));
  try {
    guard.exec('BEGIN EXCLUSIVE');
    try {
      await writeFile(lock, process.pid + '\n', {flag: 'wx'});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = (await readFile(lock, 'utf8')).trim();
      if (!/^[1-9]\d{0,9}$/.test(pid) || Number(pid) > 2147483647) throw error;
      try { process.kill(Number(pid), 0); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw error;
        await rm(lock);
        await writeFile(lock, process.pid + '\n', {flag: 'wx'});
        return release;
      }
      throw error;
    }
    return release;
  } catch (error) { guard.close(); throw error; }

  async function release() {
    try { await rm(lock); } finally { guard.close(); }
  }
}
