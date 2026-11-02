import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { SHELL_DATABASE, openShellDatabase, type ShellDatabase } from '../../src/storage/database.ts';
import type { SQLiteConnection, SQLiteModule, SQLiteValue, TrustedRegistration } from '../../src/storage/ports.ts';
export const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
export function registration(patch: Partial<TrustedRegistration> = {}): TrustedRegistration {
  return { user: hex(1), publisher: hex(2), appId: 'test-app', version: hex(3), instanceId: 'instance_1', assertActive: () => { assert(true); }, ...patch };
}
export type Fault = { prefix: string; mode: 'before' | 'after' | 'omit'; nth?: number };
/** Test-only port adapter. Statements execute in Node24's actual on-disk SQLite engine. */
export class DiskSQLite implements SQLiteModule {
  readonly directory: string;
  constructor(directory?: string) { this.directory = directory ?? mkdtempSync(join(tmpdir(), 'shell-storage-')); }
  readonly connections = new Set<DatabaseSync>();
  readonly openOptions: unknown[] = [];
  readonly calls: { sql: string; params: SQLiteValue[] }[] = [];
  faults: Fault[] = [];
  onStep: ((sql: string) => void | Promise<void>) | undefined;
  async step<T>(sql: string, params: SQLiteValue[], action: () => T, omitted?: T): Promise<T> {
    this.calls.push({ sql, params });
    const fault = this.faults.find(item => sql.startsWith(item.prefix) && (item.nth = (item.nth ?? 1) - 1) <= 0);
    if (fault) this.faults.splice(this.faults.indexOf(fault), 1);
    if (fault?.mode === 'before') throw new Error('TEST ONLY raw sensitive-looking diagnostic');
    const result = fault?.mode === 'omit' ? omitted as T : action();
    await this.onStep?.(sql);
    if (fault?.mode === 'after') throw new Error('TEST ONLY lost acknowledgement');
    return result;
  }
  async openDatabaseAsync(name: string, options: { useNewConnection: true; enableChangeListener: false }): Promise<SQLiteConnection> {
    assert.ok(name === SHELL_DATABASE || name === 'hypergolic-published-artifacts-v1.db' || name === 'hypergolic-public-identity-v1.db' || name === 'hypergolic-identity-list-access-v1.db' || name === 'hypergolic-routing-v1.db' || name === 'hypergolic-notify-v1.db' || name === 'hypergolic-outbox-lists-v1.db'); this.openOptions.push(options);
    const db = await this.step('OPEN', [], () => new DatabaseSync(join(this.directory, name)));
    this.connections.add(db);
    return {
      execAsync: sql => this.step(sql, [], () => { db.exec(sql); }),
      runAsync: (sql, ...params) => this.step(sql, params, () => ({ changes: Number(db.prepare(sql).run(...params).changes) }), { changes: 0 }),
      getAllAsync: <T>(sql: string, ...params: SQLiteValue[]) => this.step(sql, params, () => db.prepare(sql).all(...params) as T[], []),
      isInTransactionAsync: () => this.step('IS_TRANSACTION', [], () => db.isTransaction),
      closeAsync: () => this.step('CLOSE', [], () => { db.close(); this.connections.delete(db); }),
    };
  }
  raw(name = SHELL_DATABASE): DatabaseSync { const db = new DatabaseSync(join(this.directory, name)); this.connections.add(db); return db; }
  cleanup(): void { for (const db of this.connections) db.close(); this.connections.clear(); rmSync(this.directory, { recursive: true }); }
}
export async function setup(t: { after(fn: () => void): void }, platform: 'android' | 'ios' = 'ios'): Promise<{ sqlite: DiskSQLite; database: ShellDatabase }> {
  const sqlite = new DiskSQLite(); t.after(() => sqlite.cleanup());
  const database = await openShellDatabase(sqlite, platform);
  return { sqlite, database };
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
export function assertCode(code: string) { return (error: unknown) => { assert.equal((error as { code?: string }).code, code); assert.equal((error as Error).message, code); return true; }; }
