import { createConnection, type Access } from '../storage/connection.ts';
import { publicKey, utf8Bytes } from '../storage/codec.ts';
import { configure } from '../storage/schema.ts';
import { fail, type RequestOptions, type SQLiteModule, type TrustedUser } from '../storage/ports.ts';
import { assertVerifiedArtifact, MAX_MANIFEST_BYTES, verifyManifest, type VerifiedNappletArtifact, type VerifiedNappletManifest } from '../napplets/verified-artifact.ts';
import { routingRole, routingText, stableConvention } from './routing-contract.ts';

export const ROUTING_DATABASE = 'hypergolic-routing-v1.db';
export const CATALOG_LIMITS = Object.freeze({ perIdentity: 64, total: 256, bytes: 4 * 1024 * 1024 });
const CATALOG = 'CREATE TABLE routing_catalog (user TEXT NOT NULL, publisher TEXT NOT NULL, app_id TEXT NOT NULL, event_id TEXT NOT NULL, signed_event TEXT NOT NULL CHECK (length(CAST(signed_event AS BLOB)) <= 65536), PRIMARY KEY (user, publisher, app_id)) WITHOUT ROWID';
const DEFAULTS = 'CREATE TABLE routing_defaults (user TEXT NOT NULL, archetype TEXT NOT NULL, publisher TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (user, archetype), FOREIGN KEY (user, publisher, app_id) REFERENCES routing_catalog (user, publisher, app_id) ON DELETE CASCADE) WITHOUT ROWID';
export type HandlerRole = Readonly<{ archetype: string; conventions: readonly string[] }>;
export type CatalogHandler = Readonly<{ publisher: string; appId: string; eventId: string; version: string; title: string; roles: readonly HandlerRole[]; manifest: VerifiedNappletManifest }>;
export type HandlerPreference = Readonly<{ archetype: string; publisher: string; appId: string }>;
export type CatalogSnapshot = Readonly<{ handlers: readonly CatalogHandler[]; defaults: readonly HandlerPreference[] }>;
export interface RoutingCatalog {
  remember(owner: TrustedUser, artifact: VerifiedNappletArtifact, options?: RequestOptions): Promise<void>;
  list(owner: TrustedUser, options?: RequestOptions): Promise<CatalogSnapshot>;
  prefer(owner: TrustedUser, archetype: string, handler: Readonly<{ publisher: string; appId: string }> | null, options?: RequestOptions): Promise<void>;
  remove(owner: TrustedUser, handler: Readonly<{ publisher: string; appId: string }>, options?: RequestOptions): Promise<void>;
  close(): Promise<void>;
}
/** Role metadata is taken only from a verified manifest, never from a guest request. */
function handlerFrom(manifest: VerifiedNappletManifest): CatalogHandler {
  const appId = routingText(manifest.tags.find(tag => tag[0] === 'd')?.[1], 255);
  const roles = new Map<string, Set<string>>();
  for (const tag of manifest.tags) {
    if (tag[0] !== 'archetype') continue;
    if (tag.length < 2 || tag.length > 18) return fail('INVALID_INPUT');
    const archetype = routingRole(tag[1]);
    const conventions = roles.get(archetype) ?? new Set<string>();
    for (const convention of tag.slice(2)) conventions.add(stableConvention(convention));
    roles.set(archetype, conventions);
    if (roles.size > 16 || conventions.size > 16) return fail('QUOTA_EXCEEDED');
  }
  let title = '';
  for (const character of appId) {
    if (utf8Bytes(title + character) > 128) break;
    title += character;
  }
  return Object.freeze({ publisher: manifest.pubkey, appId, eventId: manifest.eventId, version: manifest.versionId, title,
    roles: Object.freeze([...roles].map(([archetype, conventions]) => Object.freeze({ archetype, conventions: Object.freeze([...conventions]) }))), manifest });
}
const signedEvent = (manifest: VerifiedNappletManifest) => JSON.stringify({ id: manifest.id, pubkey: manifest.pubkey, created_at: manifest.created_at, kind: manifest.kind, tags: manifest.tags, content: manifest.content, sig: manifest.sig });
type Row = { publisher: string; app_id: string; event_id: string; signed_event: string };
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function identity(owner: TrustedUser): Readonly<{ user: string; active(): void }> {
  const user = publicKey(owner.user), assertActive = owner.assertActive;
  if (typeof assertActive !== 'function') return fail('INVALID_INPUT');
  return Object.freeze({ user, active: () => { if (owner.user !== user || owner.assertActive !== assertActive) fail('REVOKED'); assertActive(); } });
}
function key(value: Readonly<{ publisher: string; appId: string }>) {
  return { publisher: publicKey(value.publisher), appId: routingText(value.appId, 255) };
}
/** Await every outstanding statement before a transaction can commit or roll back. */
async function completed<T>(requests: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(requests);
  return settled.map(result => {if (result.status === 'rejected') throw result.reason; return result.value;});
}
async function verifiedRow(row: Row, check: () => void): Promise<CatalogHandler | null> {
  check();
  try {
    if (typeof row.signed_event !== 'string' || utf8Bytes(row.signed_event) > MAX_MANIFEST_BYTES) return fail('CORRUPT_STORAGE');
    const manifest = await verifyManifest({kind: 35129, pubkey: publicKey(row.publisher), identifier: routingText(row.app_id, 255), relayHints: []}, JSON.parse(row.signed_event));
    check(); if (manifest.eventId !== row.event_id) return fail('CORRUPT_STORAGE');
    return handlerFrom(manifest);
  } catch {check(); return null;}
}
async function read(io: Access, user: string, check: () => void): Promise<CatalogSnapshot> {
  const rows = await io.all<Row>('SELECT publisher, app_id, event_id, signed_event FROM routing_catalog WHERE user = ? ORDER BY publisher, app_id', user);
  if (rows.length > CATALOG_LIMITS.perIdentity) return fail('CORRUPT_STORAGE');
  const verified = await completed(rows.map(row => verifiedRow(row, check))); check();
  const handlers: CatalogHandler[] = [], damaged: Row[] = [];
  for (let index = 0; index < rows.length; index++) {const handler = verified[index]; if (handler) handlers.push(handler); else damaged.push(rows[index]!);}
  const removed = await completed(damaged.map(row => io.run('DELETE FROM routing_catalog WHERE user = ? AND publisher = ? AND app_id = ?', user, row.publisher, row.app_id)));
  if (removed.some(changes => changes !== 1)) return fail('STORAGE_FAILURE');
  const rowsDefaults = await io.all<{archetype: string; publisher: string; app_id: string}>('SELECT archetype, publisher, app_id FROM routing_defaults WHERE user = ? ORDER BY archetype', user);
  if (rowsDefaults.length > CATALOG_LIMITS.perIdentity * 16) return fail('CORRUPT_STORAGE');
  const defaults: HandlerPreference[] = [], invalid: string[] = [];
  for (const row of rowsDefaults) {
    const handler = handlers.find(item => item.publisher === row.publisher && item.appId === row.app_id);
    if (!handler?.roles.some(role => role.archetype === row.archetype)) invalid.push(row.archetype);
    else defaults.push(Object.freeze({archetype: row.archetype, publisher: row.publisher, appId: row.app_id}));
  }
  await completed(invalid.map(archetype => io.run('DELETE FROM routing_defaults WHERE user = ? AND archetype = ?', user, archetype)));
  return Object.freeze({handlers: Object.freeze(handlers), defaults: Object.freeze(defaults)});
}
/** App-owned catalog and explicit preferences; removal does not touch napplet data or artifacts. */
export async function openRoutingCatalog(sqlite: SQLiteModule, platform: 'android' | 'ios'): Promise<RoutingCatalog> {
  if (platform !== 'android' && platform !== 'ios') return fail('INVALID_INPUT');
  const db = await sqlite.openDatabaseAsync(ROUTING_DATABASE, { useNewConnection: true, enableChangeListener: false });
  const connection = createConnection(db);
  try {
    await configure(db, platform);
    await connection.transaction(() => connection.assertOpen(), async io => {
      const statements = await completed([io.all<Record<string, unknown>>('PRAGMA user_version'), io.all<Record<string, unknown>>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")]);
      const versions = statements[0]!;
      let objects = statements[1]!;
      if (versions.length !== 1) return fail('CORRUPT_STORAGE');
      if (versions[0]!.user_version === 0 && objects.length === 0) {
        await io.run(CATALOG); await io.run(DEFAULTS); await io.run('PRAGMA user_version = 1');
        objects = await io.all("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
      } else if (versions[0]!.user_version !== 1) return fail('CORRUPT_STORAGE');
      if (objects.length !== 2 || objects[0]!.name !== 'routing_catalog' || objects[0]!.type !== 'table' || objects[0]!.sql !== CATALOG || objects[1]!.name !== 'routing_defaults' || objects[1]!.type !== 'table' || objects[1]!.sql !== DEFAULTS) return fail('CORRUPT_STORAGE');
    });
  } catch (error) { await connection.abort(); throw error; }
  async function request<T>(owner: TrustedUser, options: RequestOptions | undefined, action: (io: Access, user: string, check: () => void) => Promise<T>): Promise<T> {
    const captured = identity(owner), lease = connection.lease(captured.active);
    try { return await lease.submit(options, check => connection.transaction(check, io => action(io, captured.user, check))); }
    finally { lease.revoke(); }
  }
  return Object.freeze({
    remember: async (owner: TrustedUser, artifact: VerifiedNappletArtifact, options?: RequestOptions) => {
      assertVerifiedArtifact(artifact);
      const handler = handlerFrom(artifact.manifest), payload = signedEvent(artifact.manifest);
      return request(owner, options, async (io, user, check) => {
        const statements = await completed([io.all<Record<string, unknown>>('SELECT count(*) AS count, COALESCE(sum(length(CAST(signed_event AS BLOB))), 0) AS bytes, COALESCE(sum(user = ?), 0) AS owner_count FROM routing_catalog', user), io.all<Record<string, unknown>>('SELECT length(CAST(signed_event AS BLOB)) AS bytes FROM routing_catalog WHERE user = ? AND publisher = ? AND app_id = ?', user, handler.publisher, handler.appId)]);
        const stats = statements[0]!, previous = statements[1]!;
        const stat = stats[0];
        if (stats.length !== 1 || !stat || !count(stat.count) || !count(stat.bytes) || !count(stat.owner_count) || previous.length > 1 || previous.some(row => !count(row.bytes)) || stat.count > CATALOG_LIMITS.total || stat.owner_count > CATALOG_LIMITS.perIdentity || stat.bytes > CATALOG_LIMITS.bytes) return fail('CORRUPT_STORAGE');
        if (stat.count + (previous.length ? 0 : 1) > CATALOG_LIMITS.total || stat.owner_count + (previous.length ? 0 : 1) > CATALOG_LIMITS.perIdentity || stat.bytes - (previous.length ? previous[0]!.bytes as number : 0) + utf8Bytes(payload) > CATALOG_LIMITS.bytes) return fail('QUOTA_EXCEEDED');
        if (await io.run('INSERT INTO routing_catalog (user, publisher, app_id, event_id, signed_event) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user, publisher, app_id) DO UPDATE SET event_id = excluded.event_id, signed_event = excluded.signed_event', user, handler.publisher, handler.appId, handler.eventId, payload) !== 1) return fail('STORAGE_FAILURE');
        const saved = await io.all<Row>('SELECT publisher, app_id, event_id, signed_event FROM routing_catalog WHERE user = ? AND publisher = ? AND app_id = ?', user, handler.publisher, handler.appId);
        if (saved.length !== 1 || saved[0]!.signed_event !== payload || saved[0]!.event_id !== handler.eventId) return fail('STORAGE_FAILURE');
        await read(io, user, check);
      });
    },
    list: (owner: TrustedUser, options?: RequestOptions) => request(owner, options, (io, user, check) => read(io, user, check)),
    prefer: (owner: TrustedUser, archetypeInput: string, selected: Readonly<{ publisher: string; appId: string }> | null, options?: RequestOptions) => {
      const archetype = routingRole(archetypeInput), selectedKey = selected === null ? null : key(selected);
      return request(owner, options, async (io, user, check) => {
        if (selectedKey === null) { await io.run('DELETE FROM routing_defaults WHERE user = ? AND archetype = ?', user, archetype); return; }
        const snapshot = await read(io, user, check);
        if (!snapshot.handlers.some(handler => handler.publisher === selectedKey.publisher && handler.appId === selectedKey.appId && handler.roles.some(role => role.archetype === archetype))) return fail('INVALID_INPUT');
        if (await io.run('INSERT INTO routing_defaults (user, archetype, publisher, app_id) VALUES (?, ?, ?, ?) ON CONFLICT(user, archetype) DO UPDATE SET publisher = excluded.publisher, app_id = excluded.app_id', user, archetype, selectedKey.publisher, selectedKey.appId) !== 1) return fail('STORAGE_FAILURE');
        const saved = await io.all<{ publisher: string; app_id: string }>('SELECT publisher, app_id FROM routing_defaults WHERE user = ? AND archetype = ?', user, archetype);
        if (saved.length !== 1 || saved[0]!.publisher !== selectedKey.publisher || saved[0]!.app_id !== selectedKey.appId) return fail('STORAGE_FAILURE');
      });
    },
    remove: (owner: TrustedUser, selected: Readonly<{ publisher: string; appId: string }>, options?: RequestOptions) => {
      const captured = key(selected);
      return request(owner, options, async (io, user) => {
        await io.run('DELETE FROM routing_catalog WHERE user = ? AND publisher = ? AND app_id = ?', user, captured.publisher, captured.appId);
        if ((await io.all('SELECT 1 FROM routing_catalog WHERE user = ? AND publisher = ? AND app_id = ?', user, captured.publisher, captured.appId)).length || (await io.all('SELECT 1 FROM routing_defaults WHERE user = ? AND publisher = ? AND app_id = ?', user, captured.publisher, captured.appId)).length) return fail('STORAGE_FAILURE');
      });
    },
    close: () => connection.close(),
  });
}
