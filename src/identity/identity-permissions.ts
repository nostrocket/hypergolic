import {createConnection} from '../storage/connection.ts';
import {configure} from '../storage/schema.ts';
import {publicKey, text} from '../storage/codec.ts';
import {fail, type SQLiteModule, type SQLiteConnection} from '../storage/ports.ts';
import {decodeNativeRegistration, type NativeRegistration} from '../runtime/capability-protocol.ts';
import {IdentityDataError} from './identity-contract.ts';
import type {IdentityPermissionPort} from './identity-service.ts';
export const IDENTITY_PERMISSION_DATABASE = 'hypergolic-identity-list-access-v1.db';
const TABLE = 'CREATE TABLE identity_list_access (user TEXT NOT NULL, publisher TEXT NOT NULL, app TEXT NOT NULL, PRIMARY KEY (user, publisher, app)) WITHOUT ROWID';
export type IdentityListOwner = Readonly<{user: string; publisher: string; appId: string}>;
export interface IdentityListNativePolicy {replace(owners: readonly IdentityListOwner[]): void}
export type IdentityListReview = Readonly<{id: number; owner: IdentityListOwner; source: 'published' | 'bundled'}>;
export type IdentityListAccessSnapshot = Readonly<{grants: readonly IdentityListOwner[]; denied: readonly IdentityListOwner[]; review: IdentityListReview | null; busy: boolean; error: string | null}>;
export interface IdentityListAccess extends IdentityPermissionPort {
  getSnapshot(): IdentityListAccessSnapshot; subscribe(listener: () => void): () => void;
  decide(id: number, allow: boolean): Promise<void>;
  revoke(owner: IdentityListOwner): Promise<void>;
  dismissPending(): void;
  close(): Promise<void>;
}
function owner(input: IdentityListOwner): IdentityListOwner {return Object.freeze({user: publicKey(input.user), publisher: publicKey(input.publisher), appId: text(input.appId, 1024)});}
const key = (value: IdentityListOwner) => JSON.stringify([value.user, value.publisher, value.appId]);
async function readPermissions(connection: ReturnType<typeof createConnection>, check: () => void): Promise<readonly IdentityListOwner[]> {
    const rows = await connection.access(check).all<{user: string; publisher: string; app: string}>('SELECT user, publisher, app FROM identity_list_access ORDER BY user, publisher, app LIMIT 65');
    if (rows.length > 64) return fail('CORRUPT_STORAGE');
    const owners = rows.map(row => owner({user: row.user, publisher: row.publisher, appId: row.app}));
    if (new Set(owners.map(key)).size !== owners.length) return fail('CORRUPT_STORAGE');
    return Object.freeze(owners);
}
async function initializePermissions(connection: ReturnType<typeof createConnection>, db: SQLiteConnection, platform: 'android' | 'ios'): Promise<void> {
    await configure(db, platform);
    await connection.transaction(() => connection.assertOpen(), async io => {
      const [versions, objects] = await Promise.all([
        io.all<{user_version: number}>('PRAGMA user_version'),
        io.all<{type: string; name: string; sql: string}>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      ]);
      if (versions.length !== 1) return fail('CORRUPT_STORAGE');
      if (versions[0]!.user_version === 0 && objects.length === 0) {await db.execAsync(TABLE); await db.execAsync('PRAGMA user_version = 1');}
      else if (versions[0]!.user_version !== 1 || objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'identity_list_access' || objects[0]!.sql !== TABLE) return fail('CORRUPT_STORAGE');
    });
}
/** Snapshot before callbacks, which can synchronously remove or register listeners. */
function eachSnapshot<T>(values: Iterable<T>, callback: (value: T) => void): void {
  const snapshot = Array.from(values);
  for (const value of snapshot) callback(value);
}
type PermissionConnection = ReturnType<typeof createConnection>;
type PermissionLease = ReturnType<PermissionConnection['lease']>;
async function rememberPermission(connection: PermissionConnection, lease: PermissionLease, value: IdentityListOwner, signal: AbortSignal): Promise<readonly IdentityListOwner[]> {
  return lease.submit({signal}, check => connection.transaction(check, async io => {
    const existing = await readPermissions(connection, check);
    if (existing.length >= 64 && !existing.some(row => key(row) === key(value))) throw new IdentityDataError('public list permission limit');
    const present = existing.some(row => key(row) === key(value));
    if (!present && await io.run('INSERT INTO identity_list_access (user, publisher, app) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', value.user, value.publisher, value.appId) !== 1) return fail('STORAGE_FAILURE');
    const saved = await readPermissions(connection, check);
    if (!saved.some(row => key(row) === key(value)) || saved.length !== existing.length + (present ? 0 : 1)) return fail('STORAGE_FAILURE');
    return saved;
  }));
}
async function forgetPermission(connection: PermissionConnection, lease: PermissionLease, value: IdentityListOwner): Promise<readonly IdentityListOwner[]> {
  return lease.submit(undefined, check => connection.transaction(check, async io => {
    if (await io.run('DELETE FROM identity_list_access WHERE user = ? AND publisher = ? AND app = ?', value.user, value.publisher, value.appId) !== 1) return fail('STORAGE_FAILURE');
    const saved = await readPermissions(connection, check);
    if (saved.some(row => key(row) === key(value))) return fail('STORAGE_FAILURE');
    return saved;
  }));
}
function permissionGuard(readers: Set<() => void>, value: IdentityListOwner, signal: AbortSignal, onRevoke: () => void, activeOwner: (value: IdentityListOwner) => void, revision: () => number, permitted: () => readonly IdentityListOwner[]): () => void {
  const stop = () => {readers.delete(onRevoke); signal.removeEventListener('abort', stop);};
  readers.add(onRevoke); signal.addEventListener('abort', stop, {once: true});
  if (signal.aborted) stop();
  const expected = revision();
  return () => {activeOwner(value); if (revision() !== expected || !permitted().some(row => key(row) === key(value))) throw new IdentityDataError('public list access revoked');};
}
/** No guest receives this service, SQL connection, native mirror, decision or revocation method. */
export async function openIdentityListAccess(sqlite: SQLiteModule, platform: 'android' | 'ios', native: IdentityListNativePolicy, currentUser: () => string): Promise<IdentityListAccess> {
  native.replace([]);
  const db = await sqlite.openDatabaseAsync(IDENTITY_PERMISSION_DATABASE, {useNewConnection: true, enableChangeListener: false});
  const connection = createConnection(db);
  let grants: readonly IdentityListOwner[] = Object.freeze([]), revision = 0, closed = false, busy = false, error: string | null = null, counter = 0;
  const denied = new Set<string>(), listeners = new Set<() => void>();
  type Pending = {review: IdentityListReview; active: () => void; signal: AbortSignal; onRevoke: () => void; stop: () => void; resolve(check: () => void): void; reject(error: Error): void};
  const pending = new Map<number, Pending>();
  let snapshot: IdentityListAccessSnapshot = Object.freeze({grants, denied: Object.freeze([]), review: null, busy, error});
  const permitted = () => grants.filter(value => !denied.has(key(value)));
  const publish = () => {snapshot = Object.freeze({grants, denied: Object.freeze(grants.filter(value => denied.has(key(value)))), review: pending.values().next().value?.review ?? null, busy, error}); for (const listener of listeners) {try {listener();} catch { /* Presentation cannot change authority. */ }}};
  const activeOwner = (value: IdentityListOwner) => {connection.assertOpen(); if (closed || currentUser() !== value.user) throw new IdentityDataError('public list owner changed');};
  const read = (check: () => void) => readPermissions(connection, check);
  const finish = (item: Pending, check: (() => void) | null, reason = 'public list access denied') => {
    if (!pending.delete(item.review.id)) return;
    item.signal.removeEventListener('abort', item.stop);
    if (check) item.resolve(check); else item.reject(new IdentityDataError(reason));
    publish();
  };
  const readers = new Set<() => void>();
  const permission = (value: IdentityListOwner, signal: AbortSignal, onRevoke: () => void) =>
    permissionGuard(readers, value, signal, onRevoke, activeOwner, () => revision, permitted);
  try {
    await initializePermissions(connection, db, platform);
    grants = await read(() => connection.assertOpen()); native.replace(grants); publish();
  } catch (failure) {try {native.replace([]);} catch { /* Initialization remains denied. */ } await connection.abort(); throw failure;}
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    async authorize(registration: NativeRegistration, signal: AbortSignal, assertActive: () => void, onRevoke: () => void = () => {}) {
      const captured = decodeNativeRegistration(registration), value = owner(captured);
      const active = () => {activeOwner(value); if (signal.aborted) throw new IdentityDataError('public list request cancelled'); assertActive();};
      active();
      if (permitted().some(row => key(row) === key(value))) {const check = permission(value, signal, onRevoke); check(); return check;}
      if (busy || pending.size >= 2 || [...pending.values()].some(item => key(item.review.owner) === key(value))) throw new IdentityDataError('public list approval busy');
      if (!Number.isSafeInteger(++counter)) throw new IdentityDataError('public list approval limit');
      const review = Object.freeze({id: counter, owner: value, source: captured.fixture === 'published' ? 'published' as const : 'bundled' as const});
      return new Promise<() => void>((resolve, reject) => {
        const item: Pending = {review, active, signal, onRevoke, resolve, reject, stop: () => finish(item, null, 'public list request cancelled')};
        pending.set(review.id, item); signal.addEventListener('abort', item.stop, {once: true}); error = null; publish();
        if (signal.aborted) item.stop();
      });
    },
    async decide(id: number, allow: boolean) {
      const item = pending.get(id);
      if (!item || busy || snapshot.review?.id !== id) throw new IdentityDataError('public list review expired');
      if (!allow) {finish(item, null); return;}
      busy = true; error = null; publish();
      const lease = connection.lease(item.active);
      try {
        const next = await rememberPermission(connection, lease, item.review.owner, item.signal);
        item.active(); grants = next; denied.delete(key(item.review.owner)); native.replace(permitted());
        const check = permission(item.review.owner, item.signal, item.onRevoke); check(); finish(item, check);
      } catch {error = 'Public list approval could not be saved.'; finish(item, null, 'public list approval unavailable');}
      finally {lease.revoke(); busy = false; publish();}
    },
    async revoke(input: IdentityListOwner) {
      const value = owner(input); activeOwner(value);
      if (busy || !grants.some(row => key(row) === key(value))) throw new IdentityDataError('public list revocation unavailable');
      revision++; denied.add(key(value));
      busy = true; error = null; publish();
      const lease = connection.lease(() => activeOwner(value));
      try {
        native.replace(permitted());
        eachSnapshot(readers, stop => stop());
        eachSnapshot(pending.values(), item => finish(item, null, 'public list permission changed'));
        const next = await forgetPermission(connection, lease, value);
        grants = next; denied.delete(key(value)); native.replace(permitted());
      } catch {error = 'Revocation could not be saved. Restart may restore the prior permission.'; throw new IdentityDataError('public list revocation unavailable');}
      finally {lease.revoke(); busy = false; publish();}
    },
    dismissPending() {eachSnapshot(pending.values(), item => finish(item, null, 'public list review dismissed'));},
    async close() {closed = true; revision++; native.replace([]); eachSnapshot(readers, stop => stop()); readers.clear(); eachSnapshot(pending.values(), item => finish(item, null, 'public list access closed')); listeners.clear(); await connection.close();},
  });
}
