import { fail, LIMITS, sanitize, ShellStorageError, type RequestOptions, type SQLiteConnection, type SQLiteValue } from './ports.ts';
export type Params = SQLiteValue[];
export type Check = () => void;
export interface Access {
  all<T>(sql: string, ...params: Params): Promise<T[]>;
  run(sql: string, ...params: Params): Promise<number>;
}
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function createConnection(db: SQLiteConnection) {
  let closed = false, poisoned = false, pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  async function poison(): Promise<void> { poisoned = true; closed = true; try { await db.closeAsync(); } catch { /* Never reuse a poisoned connection. */ } }
  function access(check: Check): Access {
    return {
      all: async <T>(sql: string, ...params: Params) => { check(); const rows = await db.getAllAsync<T>(sql, ...params); check(); return rows; },
      run: async (sql: string, ...params: Params) => { check(); const result = await db.runAsync(sql, ...params); check(); if (!safeCount(result.changes)) fail('CORRUPT_STORAGE'); return result.changes; },
    };
  }
  async function transaction<T>(check: Check, action: (io: Access) => Promise<T>): Promise<T> {
    let attemptedCommit = false, committed = false;
    try {
      check(); await db.execAsync('BEGIN IMMEDIATE'); check();
      const result = await action(access(check));
      check(); attemptedCommit = true; await db.execAsync('COMMIT'); committed = true; check();
      return result;
    } catch (error) {
      let active: boolean;
      try { active = await db.isInTransactionAsync(); if (active) await db.execAsync('ROLLBACK'); }
      catch { await poison(); return fail('STORAGE_INDETERMINATE'); }
      if (attemptedCommit && !committed && !active) return fail('STORAGE_INDETERMINATE');
      throw sanitize(error);
    }
  }
  function queue<T>(check: Check, action: () => Promise<T>): Promise<T> {
    try { check(); } catch (error) { return Promise.reject(sanitize(error)); }
    if (pending >= LIMITS.totalRequests) return Promise.reject(new ShellStorageError('BUSY'));
    pending++;
    const result = tail.then(async () => { check(); try { const value = await action(); check(); return value; } catch (error) { throw sanitize(error); } });
    tail = result.catch(() => undefined);
    return result.finally(() => { pending--; });
  }
  function lease(assertActive: Check) {
    let revoked = false, requests = 0;
    function check(signal?: AbortSignal): void {
      if (poisoned) fail('STORAGE_INDETERMINATE');
      if (closed || revoked) fail('REVOKED');
      if (signal?.aborted) fail('CANCELLED');
      try { assertActive(); } catch { fail('REVOKED'); }
    }
    return {
      revoke: () => { revoked = true; },
      submit: <T>(options: RequestOptions | undefined, action: (check: Check) => Promise<T>): Promise<T> => {
        const signal = options?.signal;
        const validate = () => check(signal);
        try {
          validate();
          if (requests >= LIMITS.bindingRequests) return Promise.reject(new ShellStorageError('BUSY'));
          requests++;
          const result = queue(validate, () => action(validate));
          return result.finally(() => { requests--; });
        } catch (error) { return Promise.reject(sanitize(error)); }
      },
    };
  }
  function close(): Promise<void> {
    if (closed) return Promise.reject(new ShellStorageError('REVOKED'));
    closed = true;
    const result = tail.then(async () => { try { await db.closeAsync(); } catch { fail('STORAGE_FAILURE'); } });
    tail = result.catch(() => undefined);
    return result;
  }
  return { access, transaction, lease, close, assertOpen: () => { if (closed) fail('REVOKED'); },
    abort: async () => { if (!closed) await poison(); } };
}
export type StorageConnection = ReturnType<typeof createConnection>;
