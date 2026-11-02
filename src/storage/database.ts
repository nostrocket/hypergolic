import { configure, schema, SHELL_DATABASE } from './schema.ts';
import { decodeSnapshot, encodeSnapshot, identifier, publicKey, revision, text, utf8Bytes, version } from './codec.ts';
import { fail, LIMITS, sanitize, ShellStorageError, type AccessGrant, type Binding, type RequestOptions, type Scope, type SQLiteConnection, type SQLiteModule, type StringStorage, type TrustedApp, type TrustedRegistration, type TrustedUser } from './ports.ts';
import type { WorkspaceSnapshot } from '../shell/workspace.ts';
export { SHELL_DATABASE } from './schema.ts';
export interface WorkspaceRecord { readonly revision: number; readonly snapshot: WorkspaceSnapshot }
export interface WorkspaceStorage {
  load(options?: RequestOptions): Promise<WorkspaceRecord | null>;
  save(snapshot: WorkspaceSnapshot, expectedRevision: number | null, options?: RequestOptions): Promise<WorkspaceRecord>;
}
export interface UpdateReceipt {
  readonly receiptId: string; readonly fromVersion: string; readonly targetVersion: string;
  readonly rowCount: number; readonly byteCount: number; readonly workspaceRevision: number | null;
  readonly targetEventId: string | null;
}
export interface AcceptedUpdate {
  readonly fromVersion: string; readonly targetVersion: string; readonly targetEventId: string; readonly receiptId: string;
  /** Registry proves explicit acceptance, verified target, and all old generations frozen/revoked. */
  readonly assertFrozen: () => void;
}
export interface AppStorageControl {
  selectedVersion(options?: RequestOptions): Promise<string | null>;
  selectInitialVersion(version: string, options?: RequestOptions): Promise<void>;
  acceptUpdate(update: AcceptedUpdate, options?: RequestOptions): Promise<UpdateReceipt>;
  receipt(receiptId: string, options?: RequestOptions): Promise<UpdateReceipt | null>;
  readAccessGrant(options?: RequestOptions): Promise<AccessGrant | null>;
  replaceAccessGrant(domains: readonly string[], expectedRevision: number | null, options?: RequestOptions, supportReview?: string): Promise<AccessGrant>;
  revokeAccessGrant(expectedRevision: number, options?: RequestOptions): Promise<void>;
}
/** Trusted-shell factory. Never expose this object, binding/revoke controls or SQL to a napplet. */
export interface ShellDatabase {
  bindWorkspace(owner: TrustedUser): Binding<WorkspaceStorage>;
  bindStorage(registration: TrustedRegistration): Binding<StringStorage>;
  bindApp(owner: TrustedApp): Binding<AppStorageControl>;
  close(): Promise<void>;
}
import { createConnection, type StorageConnection, type Access, type Params } from './connection.ts';
type Check = () => void;
const OWNER = 'user = ? AND publisher = ? AND app = ?';
const VERSION = `${OWNER} AND version = ?`;
const NAMESPACE = `${VERSION} AND scope = ? AND instance = ?`;
const STRINGS = `SELECT key, value FROM saved_strings WHERE ${NAMESPACE} ORDER BY key COLLATE BINARY`;
const STATS = `SELECT count(*) AS count, COALESCE(sum(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0) AS bytes FROM saved_strings WHERE ${NAMESPACE}`;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function scopeValue(value: unknown): Scope { if (value === undefined || value === 'shared') return 'shared'; if (value === 'instance') return value; return fail('INVALID_INPUT'); }
type Owner = [string, string, string];
function appParams(owner: TrustedApp): Owner { return [publicKey(owner.user), publicKey(owner.publisher), text(owner.appId, 1024)]; }
function liveFunction(value: unknown): Check { if (typeof value !== 'function') return fail('INVALID_INPUT'); return value as Check; }

async function retained(io: Access, owner: Params, aggregate: string): Promise<void> {
  await io.run('INSERT INTO app_versions (user, publisher, app, version) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', ...owner, aggregate);
  const rows = await io.all(`SELECT version FROM app_versions WHERE ${VERSION}`, ...owner, aggregate);
  if (rows.length !== 1) fail('STORAGE_FAILURE');
}
async function namespace(io: Access, params: Params): Promise<{ key: string; value: string }[]> {
  const stats = await io.all<{ count: number; bytes: number }>(STATS, ...params);
  if (stats.length !== 1 || !safeCount(stats[0]!.count) || stats[0]!.count > LIMITS.keys || !safeCount(stats[0]!.bytes) || stats[0]!.bytes > LIMITS.namespaceBytes) return fail('CORRUPT_STORAGE');
  const rows = await io.all<{ key: string; value: string }>(STRINGS, ...params);
  try {
    let bytes = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      text(row.key, LIMITS.keyBytes, true); text(row.value, LIMITS.valueBytes, true);
      if (seen.has(row.key)) fail('CORRUPT_STORAGE');
      seen.add(row.key); bytes += utf8Bytes(row.key) + utf8Bytes(row.value);
    }
    if (rows.length !== stats[0]!.count || bytes !== stats[0]!.bytes) fail('CORRUPT_STORAGE');
  } catch { return fail('CORRUPT_STORAGE'); }
  return rows;
}
async function readWorkspace(io: Access, user: string): Promise<WorkspaceRecord | null> {
  const rows = await io.all<{ revision: number; payload: string }>('SELECT revision, payload FROM workspaces WHERE user = ?', user);
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail('CORRUPT_STORAGE');
  try { return Object.freeze({ revision: revision(rows[0]!.revision), snapshot: decodeSnapshot(rows[0]!.payload) }); }
  catch { return fail('CORRUPT_STORAGE'); }
}
async function writeWorkspace(io: Access, user: string, payload: string, expected: number | null): Promise<WorkspaceRecord> {
  const current = await readWorkspace(io, user);
  if ((current?.revision ?? null) !== expected) return fail('CONFLICT');
  const next = expected === null ? 0 : revision(expected + 1);
  const changes = expected === null
    ? await io.run('INSERT INTO workspaces (user, revision, payload) VALUES (?, ?, ?)', user, next, payload)
    : await io.run('UPDATE workspaces SET revision = ?, payload = ? WHERE user = ? AND revision = ?', next, payload, user, expected);
  if (changes !== 1) return fail('STORAGE_FAILURE');
  return Object.freeze({ revision: next, snapshot: decodeSnapshot(payload) });
}
async function selection(io: Access, owner: Params): Promise<string | null> {
  const rows = await io.all<{ version: string }>(`SELECT version FROM selected_versions WHERE ${OWNER}`, ...owner);
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail('CORRUPT_STORAGE');
  try { return version(rows[0]!.version); } catch { return fail('CORRUPT_STORAGE'); }
}
async function receipt(io: Access, owner: Params, id: string): Promise<UpdateReceipt | null> {
  const rows = await io.all<{ receipt: string; previous_version: string; version: string; row_count: number; byte_count: number; workspace_revision: number | null; target_event_id: string | null }>(`SELECT receipt, previous_version, version, row_count, byte_count, workspace_revision, target_event_id FROM update_receipts WHERE ${OWNER} AND receipt = ?`, ...owner, id);
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail('CORRUPT_STORAGE');
  const row = rows[0]!;
  try {
    identifier(row.receipt); version(row.previous_version); version(row.version);
    if (row.receipt !== id || row.previous_version === row.version || !safeCount(row.row_count) || !safeCount(row.byte_count)) fail('CORRUPT_STORAGE');
    if (row.workspace_revision !== null) revision(row.workspace_revision);
    if (row.target_event_id !== null) publicKey(row.target_event_id);
  } catch { return fail('CORRUPT_STORAGE'); }
  return Object.freeze({ receiptId: row.receipt, fromVersion: row.previous_version, targetVersion: row.version, rowCount: row.row_count, byteCount: row.byte_count, workspaceRevision: row.workspace_revision, targetEventId: row.target_event_id });
}
function canonicalDomains(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1 || value.length > 64) return fail('INVALID_INPUT');
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, 'value')) return fail('INVALID_INPUT');
    const domain = text(field.value, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(domain)) return fail('INVALID_INPUT');
    result.push(domain);
  }
  result.sort();
  if (new Set(result).size !== result.length) return fail('INVALID_INPUT');
  return Object.freeze(result);
}
function decodeAccessGrant(row: { revision: number; domains: string; support_review: string }): AccessGrant {
  try {
    const rowRevision = revision(row.revision), parsed: unknown = JSON.parse(row.domains), domains = canonicalDomains(parsed);
    if (JSON.stringify(domains) !== row.domains) fail('CORRUPT_STORAGE');
    const supportReview = text(row.support_review, 16384, true);
    return Object.freeze({ revision: rowRevision, domains, ...(supportReview ? {supportReview} : {}) });
  } catch { return fail('CORRUPT_STORAGE'); }
}
async function readAccessGrant(io: Access, owner: Params): Promise<AccessGrant | null> {
  const rows = await io.all<{ revision: number; domains: string; support_review: string }>(`SELECT revision, domains, support_review FROM access_grants WHERE ${OWNER}`, ...owner);
  if (rows.length === 0) return null;
  if (rows.length !== 1) return fail('CORRUPT_STORAGE');
  return decodeAccessGrant(rows[0]!);
}
async function replaceAccessGrant(io: Access, owner: Params, domains: readonly string[], expected: number | null, supportReview: string): Promise<AccessGrant> {
  const current = await readAccessGrant(io, owner);
  if ((current?.revision ?? null) !== expected) return fail('CONFLICT');
  const nextRevision = revision(expected === null ? 0 : expected + 1), payload = JSON.stringify(domains);
  const changed = expected === null
    ? await io.run('INSERT INTO access_grants (user, publisher, app, revision, domains, support_review) VALUES (?, ?, ?, ?, ?, ?)', ...owner, nextRevision, payload, supportReview)
    : await io.run(`UPDATE access_grants SET revision = ?, domains = ?, support_review = ? WHERE ${OWNER} AND revision = ?`, nextRevision, payload, supportReview, ...owner, expected);
  if (changed !== 1) fail('STORAGE_FAILURE');
  return Object.freeze({ revision: nextRevision, domains, ...(supportReview ? {supportReview} : {}) });
}
async function revokeAccessGrant(io: Access, owner: Params, expected: number): Promise<void> {
  const current = await readAccessGrant(io, owner);
  if (current === null || current.revision !== expected) return fail('CONFLICT');
  if (await io.run(`DELETE FROM access_grants WHERE ${OWNER} AND revision = ?`, ...owner, expected) !== 1) fail('STORAGE_FAILURE');
}
function bindWorkspace(connection: StorageConnection, owner: TrustedUser): Binding<WorkspaceStorage> {
  const { lease, access, transaction } = connection;
  const user = publicKey(owner.user), binding = lease(liveFunction(owner.assertActive));
  return Object.freeze({ revoke: binding.revoke, port: Object.freeze({
    load: (options?: RequestOptions) => binding.submit(options, check => readWorkspace(access(check), user)),
    save: (value: WorkspaceSnapshot, expectedRevision: number | null, options?: RequestOptions) => {
      const payload = encodeSnapshot(value), expected = expectedRevision === null ? null : revision(expectedRevision);
      return binding.submit(options, check => transaction(check, io => writeWorkspace(io, user, payload, expected)));
    },
  }) });
}
function bindStorage(connection: StorageConnection, registration: TrustedRegistration): Binding<StringStorage> {
  const { lease, transaction } = connection;
  const owner = appParams(registration), aggregate = version(registration.version), instance = identifier(registration.instanceId);
  const binding = lease(liveFunction(registration.assertActive));
  function request<T>(scope: Scope | undefined, options: RequestOptions | undefined, action: (io: Access, params: Params, rows: { key: string; value: string }[]) => Promise<T>): Promise<T> {
    const selectedScope = scopeValue(scope), params = [...owner, aggregate, selectedScope, selectedScope === 'instance' ? instance : ''];
    return binding.submit(options, check => transaction(check, async io => {
      await retained(io, owner, aggregate);
      const rows = await namespace(io, params);
      return action(io, params, rows);
    }));
  }
  return Object.freeze({ revoke: binding.revoke, port: Object.freeze({
    get: (key: string, scope?: Scope, options?: RequestOptions) => {
      const selectedKey = text(key, LIMITS.keyBytes, true);
      return request(scope, options, async (_io, _params, rows) => rows.find(row => row.key === selectedKey)?.value ?? null);
    },
    keys: (scope?: Scope, options?: RequestOptions) => request(scope, options, async (_io, _params, rows) => Object.freeze(rows.map(row => row.key))),
    set: (key: string, value: string, scope?: Scope, options?: RequestOptions) => {
      const selectedKey = text(key, LIMITS.keyBytes, true), selectedValue = text(value, LIMITS.valueBytes, true);
      return request(scope, options, async (io, params, rows) => {
        const others = rows.filter(row => row.key !== selectedKey);
        const bytes = others.reduce((total, row) => total + utf8Bytes(row.key) + utf8Bytes(row.value), 0) + utf8Bytes(selectedKey) + utf8Bytes(selectedValue);
        if (others.length + 1 > LIMITS.keys || bytes > LIMITS.namespaceBytes) fail('QUOTA_EXCEEDED');
        const changed = await io.run('INSERT INTO saved_strings (user, publisher, app, version, scope, instance, key, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user, publisher, app, version, scope, instance, key) DO UPDATE SET value = excluded.value', ...params, selectedKey, selectedValue);
        if (changed !== 1) fail('STORAGE_FAILURE');
      });
    },
    remove: (key: string, scope?: Scope, options?: RequestOptions) => {
      const selectedKey = text(key, LIMITS.keyBytes, true);
      return request(scope, options, async (io, params, rows) => {
        const changed = await io.run(`DELETE FROM saved_strings WHERE ${NAMESPACE} AND key = ?`, ...params, selectedKey);
        if (changed !== (rows.some(row => row.key === selectedKey) ? 1 : 0)) fail('STORAGE_FAILURE');
      });
    },
  }) });
}
async function copyVersion(io: Access, owner: Params, from: string, target: string): Promise<{ rowCount: number; byteCount: number }> {
  const namespaces = await io.all<{ scope: string; instance: string; count: number; bytes: number }>(`SELECT scope, instance, count(*) AS count, sum(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))) AS bytes FROM saved_strings WHERE ${VERSION} GROUP BY scope, instance`, ...owner, from);
  let rowCount = 0, byteCount = 0;
  for (const item of namespaces) {
    try {
      const scope = scopeValue(item.scope);
      if (scope === 'shared' ? item.instance !== '' : identifier(item.instance) !== item.instance) fail('CORRUPT_STORAGE');
      if (!safeCount(item.count) || item.count > LIMITS.keys || !safeCount(item.bytes) || item.bytes > LIMITS.namespaceBytes) fail('CORRUPT_STORAGE');
      rowCount += item.count; byteCount += item.bytes;
      if (!safeCount(rowCount) || !safeCount(byteCount)) fail('CORRUPT_STORAGE');
    } catch { return fail('CORRUPT_STORAGE'); }
  }
  const changed = await io.run(`INSERT INTO saved_strings (user, publisher, app, version, scope, instance, key, value) SELECT user, publisher, app, ?, scope, instance, key, value FROM saved_strings WHERE ${VERSION}`, target, ...owner, from);
  if (changed !== rowCount) fail('STORAGE_FAILURE');
  // Check both directions in one SQLite statement; no parallel work on the transaction connection.
  const difference = await io.all(`WITH original AS (SELECT scope, instance, key, value FROM saved_strings WHERE ${VERSION}), copied AS (SELECT scope, instance, key, value FROM saved_strings WHERE ${VERSION}) SELECT * FROM (SELECT * FROM original EXCEPT SELECT * FROM copied) UNION ALL SELECT * FROM (SELECT * FROM copied EXCEPT SELECT * FROM original) LIMIT 1`, ...owner, from, ...owner, target);
  if (difference.length !== 0) fail('STORAGE_FAILURE');
  return { rowCount, byteCount };
}
type UpdateTarget = { owner: Owner; from: string; target: string; targetEventId: string; id: string };
async function applyUpdate(io: Access, plan: UpdateTarget): Promise<UpdateReceipt> {
  const { owner, from, target, targetEventId, id } = plan;
  const [user, publisher, appId] = owner;
  const existing = await receipt(io, owner, id);
  if (existing && (existing.fromVersion !== from || existing.targetVersion !== target || existing.targetEventId !== targetEventId)) fail('CONFLICT');
  const selected = await selection(io, owner);
  if (existing !== null) {
    if (selected !== target) fail('CONFLICT');
    return existing;
  }
  if (selected !== from) fail('SELECTION_MISMATCH');
  if ((await io.all(`SELECT version FROM app_versions WHERE ${VERSION}`, ...owner, target)).length !== 0) fail('TARGET_RETAINED');
  const workspace = await readWorkspace(io, user);
  let workspaceRevision = workspace?.revision ?? null;
  if (workspace) {
    let changed = false;
    const sessions = workspace.snapshot.sessions.map(item => {
      if (item.publisher !== publisher || item.appId !== appId || item.source !== 'published') return item;
      if (item.version !== from) return fail('CONFLICT');
      changed = true; return { ...item, version: target, eventId: targetEventId };
    });
    if (changed) workspaceRevision = (await writeWorkspace(io, user, encodeSnapshot({ ...workspace.snapshot, sessions }), workspace.revision)).revision;
  }
  await retained(io, owner, target);
  const counts = await copyVersion(io, owner, from, target);
  if (await io.run(`UPDATE selected_versions SET version = ? WHERE ${OWNER} AND version = ?`, target, ...owner, from) !== 1) fail('STORAGE_FAILURE');
  if (await io.run('INSERT INTO update_receipts (user, publisher, app, receipt, previous_version, version, row_count, byte_count, workspace_revision, target_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...owner, id, from, target, counts.rowCount, counts.byteCount, workspaceRevision, targetEventId) !== 1) fail('STORAGE_FAILURE');
  return Object.freeze({ receiptId: id, fromVersion: from, targetVersion: target, ...counts, workspaceRevision, targetEventId });
}
async function recoverUpdate(io: Access, plan: UpdateTarget): Promise<UpdateReceipt> {
  const { owner, id, from, target } = plan;
  let actual: UpdateReceipt | null, selected: string | null;
  try {
    actual = await receipt(io, owner, id);
    selected = await selection(io, owner);
  } catch (error) {
    if (error instanceof ShellStorageError && ['REVOKED', 'CANCELLED'].includes(error.code)) throw error;
    return fail('STORAGE_INDETERMINATE');
  }
  if (actual?.fromVersion === from && actual.targetVersion === target && actual.targetEventId === plan.targetEventId && selected === target) return actual;
  if (actual === null && selected === from) return fail('STORAGE_FAILURE');
  return fail('STORAGE_INDETERMINATE');
}
function bindApp(connection: StorageConnection, context: TrustedApp): Binding<AppStorageControl> {
  const { lease, transaction, access } = connection;
  const owner = appParams(context);
  const binding = lease(liveFunction(context.assertActive));
  function grantRead(options?: RequestOptions) { return binding.submit(options, check => readAccessGrant(access(check), owner)); }
  function grantReplace(domains: readonly string[], expected: number | null, options?: RequestOptions, supportReview = '') {
    // Snapshot the trusted UI's reviewed capability set before queuing any SQLite work.
    const canonical = canonicalDomains(domains), selectedExpected = expected === null ? null : revision(expected), reviewed = text(supportReview, 16384, true);
    return binding.submit(options, check => transaction(check, io => replaceAccessGrant(io, owner, canonical, selectedExpected, reviewed)));
  }
  function grantRevoke(expected: number, options?: RequestOptions) {
    return binding.submit(options, check => transaction(check, io => revokeAccessGrant(io, owner, revision(expected))));
  }
  return Object.freeze({ revoke: binding.revoke, port: Object.freeze({
    selectedVersion: (options?: RequestOptions) => binding.submit(options, check => selection(access(check), owner)),
    receipt: (id: string, options?: RequestOptions) => {
      const selectedId = identifier(id);
      return binding.submit(options, check => receipt(access(check), owner, selectedId));
    },
    readAccessGrant: grantRead,
    replaceAccessGrant: grantReplace,
    revokeAccessGrant: grantRevoke,
    selectInitialVersion: (value: string, options?: RequestOptions) => {
      const aggregate = version(value);
      return binding.submit(options, check => transaction(check, async io => {
        const selected = await selection(io, owner);
        if (selected !== null && selected !== aggregate) fail('SELECTION_MISMATCH');
        await retained(io, owner, aggregate);
        if (selected === null && await io.run('INSERT INTO selected_versions (user, publisher, app, version) VALUES (?, ?, ?, ?)', ...owner, aggregate) !== 1) fail('STORAGE_FAILURE');
      }));
    },
    acceptUpdate: (update: AcceptedUpdate, options?: RequestOptions) => {
      const from = version(update.fromVersion), target = version(update.targetVersion), targetEventId = publicKey(update.targetEventId), id = identifier(update.receiptId), assertFrozen = liveFunction(update.assertFrozen);
      if (from === target) fail('INVALID_INPUT');
      return binding.submit(options, async check => {
        function authorized(): void { check(); try { assertFrozen(); } catch { fail('REVOKED'); } }
        const plan = { owner, from, target, targetEventId, id };
        try { return await transaction(authorized, io => applyUpdate(io, plan)); }
        catch (error) {
          if (!(error instanceof ShellStorageError) || error.code !== 'STORAGE_INDETERMINATE') throw error;
          authorized();
          return recoverUpdate(access(authorized), plan);
        }
      });
    },
  }) });
}
export async function openShellDatabase(sqlite: SQLiteModule, platform: 'android' | 'ios'): Promise<ShellDatabase> {
  if (platform !== 'android' && platform !== 'ios') return fail('STORAGE_FAILURE');
  let db: SQLiteConnection;
  try { db = await sqlite.openDatabaseAsync(SHELL_DATABASE, { useNewConnection: true, enableChangeListener: false }); }
  catch { return fail('STORAGE_FAILURE'); }
  const connection = createConnection(db);
  try {
    await configure(db, platform);
    await connection.transaction(connection.assertOpen, async () => schema(db));
  } catch (error) { await connection.abort(); throw sanitize(error); }
  return Object.freeze({
    bindWorkspace: (owner: TrustedUser) => bindWorkspace(connection, owner),
    bindStorage: (owner: TrustedRegistration) => bindStorage(connection, owner),
    bindApp: (owner: TrustedApp) => bindApp(connection, owner),
    close: connection.close,
  });
}
