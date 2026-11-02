import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { IdentityVault, VaultError, type VaultDependencies, type EncryptedSecrets } from '../../src/security/identity-vault.ts';
import { createProtectedSecrets, secretStorageKey, VAULT_SERVICE, type NativePlatform, type ProtectedOptions, type SecureStoreModule } from '../../src/security/android-encrypted-secrets.ts';
import { IDENTITY_DATABASE, openIdentityMetadata, type SQLiteConnection, type SQLiteModule } from '../../src/security/identity-metadata.ts';
import type { SQLiteValue } from '../../src/storage/sqlite.ts';

export const pubkey = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
export const TEST_ID = 'test_vault_000001';
export type Fault = { match: string; mode: 'before' | 'after' | 'omit'; nth?: number };
export class Faults {
  calls: string[] = [];
  fault: Fault | null = null;
  failures: Fault[] = [];
  onStep: ((name: string) => Promise<void> | void) | null = null;
  async run<T>(name: string, apply: () => T, omitted?: T): Promise<T> {
    this.calls.push(name);
    const match = this.fault?.match === name && (this.fault.nth = (this.fault.nth ?? 1) - 1) === 0 ? this.fault : this.failures.find(f => f.match === name);
    if (match === this.fault) this.fault = null;
    if (match?.mode === 'before') throw new Error('TEST ONLY failure with secret-looking payload; must be sanitized');
    const result = match?.mode === 'omit' ? omitted as T : apply();
    await this.onStep?.(name);
    if (match?.mode === 'after') throw new Error('TEST ONLY failure after durable write');
    return result;
  }
}
export class SecureFake extends Faults implements SecureStoreModule {
  values = new Map<string, string>();
  options: ProtectedOptions[] = [];
  available = true;
  isAvailableAsync() { return this.run('available', () => this.available); }
  getItemAsync(key: string, options?: ProtectedOptions) {
    assert(options); this.options.push(options);
    return this.run(`get:${key}`, () => this.values.get(key) ?? null, null);
  }
  setItemAsync(key: string, value: string, options?: ProtectedOptions) {
    assert(options); this.options.push(options);
    return this.run(`set:${key}`, () => { this.values.set(key, value); });
  }
  deleteItemAsync(key: string, options?: ProtectedOptions) {
    assert(options); this.options.push(options);
    return this.run(`delete:${key}`, () => { this.values.delete(key); });
  }
}
/** Explicit test-only authenticated erase double; never a production fallback. */
export function deletionFixture(native: SecureFake): Pick<EncryptedSecrets, 'deleteSecret'> {
  return { deleteSecret(pubkey, grant) {
    grant.assertActive();
    const options = native.options[0] ?? Object.freeze({ keychainService: VAULT_SERVICE, requireAuthentication: false as const });
    return native.deleteItemAsync(secretStorageKey(pubkey), options);
  } };
}
export class SqliteFake extends Faults implements SQLiteModule {
  readonly directory = mkdtempSync(join(tmpdir(), 'identity-adapter-sqlite-'));
  readonly connections: DatabaseSync[] = [];
  closed = new Set<DatabaseSync>();
  openOptions: unknown[] = [];
  statements: { sql: string; params: SQLiteValue[] }[] = [];
  async openDatabaseAsync(name: string, options: { useNewConnection: true; enableChangeListener: false }): Promise<SQLiteConnection> {
    assert.equal(name, IDENTITY_DATABASE); this.openOptions.push(options);
    const db = await this.run('open', () => new DatabaseSync(join(this.directory, name)));
    this.connections.push(db);
    return {
      execAsync: sql => this.run(`exec:${sql}`, () => { this.statements.push({ sql, params: [] }); db.exec(sql); }),
      runAsync: (sql, ...params) => this.run(`run:${sql}`, () => {
        this.statements.push({ sql, params });
        return { changes: Number(db.prepare(sql).run(...params).changes) };
      }, { changes: 0 }),
      getAllAsync: <T>(sql: string, ...params: SQLiteValue[]) => this.run(`all:${sql}`, () => {
        this.statements.push({ sql, params }); return db.prepare(sql).all(...params) as T[];
      }, []),
      isInTransactionAsync: () => this.run('inTransaction', () => db.isTransaction),
      closeAsync: () => this.run('close', () => { db.close(); this.closed.add(db); }),
    };
  }
  raw(): DatabaseSync { const db = new DatabaseSync(join(this.directory, IDENTITY_DATABASE)); this.connections.push(db); return db; }
  removeDatabase(): void {
    for (const db of this.connections) if (!this.closed.has(db)) { db.close(); this.closed.add(db); }
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(this.directory, IDENTITY_DATABASE) + suffix, { force: true });
  }
  cleanup(): void { this.removeDatabase(); rmSync(this.directory, { recursive: true }); }
}
export class Integrated {
  secure = new SecureFake();
  sqlite = new SqliteFake();
  generated = 0;
  nextId = 0;
  authCalls = 0;
  authActive = true;
  async owner(platform: NativePlatform = 'ios') {
    const database = await openIdentityMetadata(this.sqlite, platform);
    const secrets = await createProtectedSecrets(this.secure, 'android', deletionFixture(this.secure));
    const dependencies: VaultDependencies = {
      database, secrets,
      // Deterministic fake keys belong ONLY to this test file. No real keys, crypto or nsec decoding.
      generateSecretKey: () => { this.generated++; return new Uint8Array(32).fill(1); },
      parseNsec: value => {
        const n = /^nsec1fixture-(\d+)$/.exec(value)?.[1];
        if (!n || Number(n) < 1 || Number(n) > 100) throw new Error('invalid test fixture');
        return new Uint8Array(32).fill(Number(n));
      },
      derivePublicKey: bytes => {
        if (bytes.length !== 32 || bytes[0] === 0) throw new Error('invalid test fixture');
        // Scalars n and 128+n deliberately map to the same x-only fixture pubkey.
        return pubkey(bytes[0]! % 128);
      },
      newId: () => `adapter_test_${String(++this.nextId).padStart(8, '0')}`,
      now: () => 1_800_000_000,
      authorizeDeletion: async () => {
        this.authCalls++;
        return { assertActive: () => { if (!this.authActive) throw new Error('revoked test grant'); } };
      },
    };
    const legacy = new IdentityVault(dependencies);
    let target = 2;
    const candidates = new WeakMap<object, number>();
    const vault = Object.assign(legacy, {
      async getSigningMethods(account: string): Promise<import('../../src/security/signing-methods.ts').SigningMethodsSnapshot> {
        const current = legacy.getSnapshot();
        if (!current.identities.some(identity => identity.pubkey === account)) throw new VaultError('NOT_FOUND');
        return { vaultId: current.vaultId, revision: current.revision, pubkey: account,
          selectedMethod: 'local' as const, methods: [{ kind: 'local' as const }] };
      },
      async prepareRemoteConnection(): Promise<Readonly<{ handle: string; pubkey: string }> | null> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      async prepareRemoteRefresh(_account: string): Promise<Readonly<{ handle: string; pubkey: string }> | null> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      cancelRemoteRefresh(_candidate: object) {},
      async commitRemoteRefresh(_candidate: object): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      cancelAction() {},
      cancelRemotePreparation() {},
      isRemotePreparationHandoffPending(): boolean { return false; },
      cancelRemoteConnection(_candidate: object) {},
      async commitRemoteConnection(_candidate: object): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      async prepareAndroidSigner(): Promise<Readonly<{ handle: string; pubkey: string }> | null> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      cancelAndroidSigner(_candidate: object) {},
      async commitAndroidSigner(_candidate: object): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      async selectSigningMethod(_account: string, _method: 'local' | 'nip46' | 'nip55'): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      async disconnectSigningMethod(_account: string, _method: 'nip46' | 'nip55'): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      async deleteLocalKey(_account: string): Promise<ReturnType<IdentityVault['getSnapshot']>> { throw new VaultError('SIGNER_UNSUPPORTED'); },
      setImportTarget(value: number) { target = value; },
      async prepareImport(): Promise<Readonly<{ handle: string; pubkey: string }>> {
        if (!Number.isInteger(target) || target < 1) throw new VaultError('INVALID_NSEC');
        const candidate = Object.freeze({ handle: `native_test_candidate_${target}`, pubkey: pubkey(target) });
        candidates.set(candidate, target);
        return candidate;
      },
      cancelImport(candidate: object) { candidates.delete(candidate); },
      async commitImport(candidate: object) {
        const value = candidates.get(candidate);
        if (value === undefined) throw new VaultError('AUTHORIZATION_DENIED');
        candidates.delete(candidate);
        return legacy.importNsec(`nsec1fixture-${value}`);
      },
    });
    return { database, secrets, vault };
  }
}
