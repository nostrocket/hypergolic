import { createConnection, type Access, type StorageConnection } from '../storage/connection.ts';
import { fail, type RequestOptions, type SQLiteModule, type TrustedApp } from '../storage/ports.ts';
import type { NappletCoordinate } from './resolve-link.ts';
import { assertVerifiedArtifact, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, verifyArtifact, verifyManifest, type VerifiedNappletArtifact } from './verified-artifact.ts';

export const PUBLISHED_ARTIFACT_CACHE_DATABASE = 'hypergolic-published-artifacts-v1.db';
export const PUBLISHED_ARTIFACT_CACHE_MAX_ROWS = 32;
export const PUBLISHED_ARTIFACT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** The epoch source must advance before an identity/session change is made visible. */
export type PublishedArtifactCacheAuthority = Readonly<{
  owner: TrustedApp;
  epoch: number;
  currentEpoch: () => number;
}>;

export interface PublishedArtifactCache {
  get(identifier: string, eventId: string, options?: RequestOptions): Promise<VerifiedNappletArtifact | null>;
  put(artifact: VerifiedNappletArtifact, options?: RequestOptions): Promise<void>;
  revoke(): void;
  close(): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const IDENTIFIER_MAX_BYTES = 255;
const MAX_STORED_ROW_BYTES = MAX_HTML_BYTES + MAX_MANIFEST_BYTES;
type Row = { publisher: string; identifier: string; event_id: string; signed_event: string; html: Uint8Array; byte_count: number };
type Stats = { count: number; bytes: number };
const CACHE_TABLE = `CREATE TABLE verified_published_artifacts (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL, publisher TEXT NOT NULL, identifier TEXT NOT NULL, event_id TEXT NOT NULL,
    signed_event TEXT NOT NULL, html BLOB NOT NULL, byte_count INTEGER NOT NULL,
    UNIQUE(user, publisher, identifier, event_id)
  )`;
const CACHE_INDEX = 'CREATE INDEX published_artifact_cache_fifo ON verified_published_artifacts(row_id)';
const validIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).byteLength <= IDENTIFIER_MAX_BYTES;
const eventFrom = (artifact: VerifiedNappletArtifact) => ({
  id: artifact.manifest.id, pubkey: artifact.manifest.pubkey, created_at: artifact.manifest.created_at,
  kind: artifact.manifest.kind, tags: artifact.manifest.tags.map(tag => [...tag]),
  content: artifact.manifest.content, sig: artifact.manifest.sig,
});

function checkStats(stats: Stats[]): Stats {
  if (stats.length !== 1 || !Number.isSafeInteger(stats[0]!.count) || stats[0]!.count < 0 ||
      !Number.isSafeInteger(stats[0]!.bytes) || stats[0]!.bytes < 0) return fail('CORRUPT_STORAGE');
  return stats[0]!;
}

async function initialize(io: Access): Promise<void> {
  const versions = await io.all<{ user_version: number }>('PRAGMA user_version');
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]!.user_version) || versions[0]!.user_version < 0 || versions[0]!.user_version > 1) return fail('CORRUPT_STORAGE');
  let version = versions[0]!.user_version;
  let objects = await io.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  if (versions[0]!.user_version === 0 && objects.length === 0) {
    await io.run(CACHE_TABLE);
    await io.run(CACHE_INDEX);
    await io.run('PRAGMA user_version = 1');
    version = 1;
    objects = await io.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  }
  const exact = objects.length === 2 && objects.some(object => object.type === 'table' && object.name === 'verified_published_artifacts' && object.sql === CACHE_TABLE) &&
    objects.some(object => object.type === 'index' && object.name === 'published_artifact_cache_fifo' && object.sql === CACHE_INDEX);
  if (version !== 1 || !exact) fail('CORRUPT_STORAGE');
}

/** A private persistent cache. Every returned artifact is freshly verified from its original signed event and bytes. */
export async function openPublishedArtifactCache(
  sqlite: SQLiteModule,
  authority: PublishedArtifactCacheAuthority,
): Promise<PublishedArtifactCache> {
  const owner = authority.owner;
  if (!Number.isSafeInteger(authority.epoch) || authority.epoch < 0 || typeof authority.currentEpoch !== 'function' ||
      typeof owner.assertActive !== 'function' || !HEX64.test(owner.user) || !HEX64.test(owner.publisher) ||
      !validIdentifier(owner.appId)) return fail('INVALID_INPUT');
  const user = owner.user, publisher = owner.publisher, appId = owner.appId, epoch = authority.epoch;
  let storage: StorageConnection | undefined;
  const assertIdentity = () => {
    try {
      if (owner.user !== user || owner.publisher !== publisher || owner.appId !== appId || authority.currentEpoch() !== epoch) fail('REVOKED');
      owner.assertActive();
    } catch { fail('REVOKED'); }
  };
  const assertOpen = () => { assertIdentity(); storage?.assertOpen(); };
  assertIdentity();
  const connection = await sqlite.openDatabaseAsync(PUBLISHED_ARTIFACT_CACHE_DATABASE, { useNewConnection: true, enableChangeListener: false });
  try {
    assertIdentity();
    await connection.execAsync('PRAGMA busy_timeout = 1500');
    await connection.execAsync('PRAGMA journal_mode = WAL');
    await connection.execAsync('PRAGMA synchronous = FULL');
    storage = createConnection(connection);
    const binding = storage.lease(assertIdentity);
    await binding.submit(undefined, check => storage!.transaction(check, initialize));
    const request = <T>(options: RequestOptions | undefined, action: (io: Access) => Promise<T>) => {
      assertOpen();
      return binding.submit(options, check => storage!.transaction(check, action));
    };
    const cache: PublishedArtifactCache = {
      get: async (identifier, eventId, options) => {
        assertOpen();
        if (!validIdentifier(identifier) || identifier !== appId || !HEX64.test(eventId)) return fail('INVALID_INPUT');
        const rows = await request(options, io => io.all<Row>(
          'SELECT publisher, identifier, event_id, signed_event, html, byte_count FROM verified_published_artifacts WHERE user = ? AND publisher = ? AND identifier = ? AND event_id = ?',
          user, publisher, identifier, eventId));
        if (rows.length === 0) return null;
        const row = rows[0]!;
        try {
          assertOpen();
          if (rows.length !== 1 || row.publisher !== publisher || row.identifier !== identifier || row.event_id !== eventId ||
              typeof row.signed_event !== 'string' || new TextEncoder().encode(row.signed_event).byteLength > MAX_MANIFEST_BYTES ||
              !(row.html instanceof Uint8Array) || row.html.byteLength === 0 || row.html.byteLength > MAX_HTML_BYTES ||
              row.byte_count !== new TextEncoder().encode(row.signed_event).byteLength + row.html.byteLength || row.byte_count > MAX_STORED_ROW_BYTES) fail('CORRUPT_STORAGE');
          const coordinate: NappletCoordinate = Object.freeze({ kind: 35129, pubkey: publisher, identifier, relayHints: Object.freeze([]) });
          const event: unknown = JSON.parse(row.signed_event);
          assertOpen();
          const manifest = await verifyManifest(coordinate, event);
          assertOpen();
          if (manifest.pubkey !== publisher || manifest.id !== eventId || manifest.eventId !== eventId) return null;
          const artifact = await verifyArtifact(manifest, new Uint8Array(row.html));
          assertOpen();
          return artifact;
        } catch (error) {
          assertOpen();
          if ((error as { code?: string })?.code === 'REVOKED' || (error as { code?: string })?.code === 'CANCELLED') throw error;
          // Persistent bytes are untrusted. Remove a corrupt entry and let the caller fetch afresh.
          await request(options, io => io.run('DELETE FROM verified_published_artifacts WHERE user = ? AND publisher = ? AND identifier = ? AND event_id = ?', user, publisher, identifier, eventId));
          return null;
        }
      },
      put: async (artifactInput, options) => {
        assertOpen(); assertVerifiedArtifact(artifactInput);
        const artifact: VerifiedNappletArtifact = artifactInput;
        const dTag = artifact.manifest.tags.find(tag => tag[0] === 'd');
        if (artifact.manifest.pubkey !== publisher || !dTag || !validIdentifier(dTag[1]) ||
            !HEX64.test(artifact.manifest.eventId)) return fail('INVALID_INPUT');
        const identifier = dTag[1];
        if (identifier !== appId) return fail('INVALID_INPUT');
        const signedEvent = JSON.stringify(eventFrom(artifact));
        const eventBytes = new TextEncoder().encode(signedEvent);
        const htmlBytes = artifact.htmlBytes;
        const byteCount = eventBytes.byteLength + htmlBytes.byteLength;
        if (eventBytes.byteLength > MAX_MANIFEST_BYTES || htmlBytes.byteLength > MAX_HTML_BYTES || byteCount > MAX_STORED_ROW_BYTES) return fail('QUOTA_EXCEEDED');
        await request(options, async io => {
          await io.run('DELETE FROM verified_published_artifacts WHERE user = ? AND publisher = ? AND identifier = ? AND event_id = ?',
            user, publisher, identifier, artifact.manifest.eventId);
          await io.run(`INSERT INTO verified_published_artifacts (user, publisher, identifier, event_id, signed_event, html, byte_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, user, publisher, identifier, artifact.manifest.eventId, signedEvent, htmlBytes, byteCount);
          let stats = checkStats(await io.all<Stats>('SELECT count(*) AS count, COALESCE(sum(byte_count), 0) AS bytes FROM verified_published_artifacts'));
          while (stats.count > PUBLISHED_ARTIFACT_CACHE_MAX_ROWS || stats.bytes > PUBLISHED_ARTIFACT_CACHE_MAX_BYTES) {
            const oldest = await io.all<{ row_id: number; byte_count: number }>('SELECT row_id, byte_count FROM verified_published_artifacts ORDER BY row_id LIMIT 1');
            if (oldest.length !== 1 || !Number.isSafeInteger(oldest[0]!.byte_count) || oldest[0]!.byte_count < 0) return fail('CORRUPT_STORAGE');
            await io.run('DELETE FROM verified_published_artifacts WHERE row_id = ?', oldest[0]!.row_id);
            stats = { count: stats.count - 1, bytes: stats.bytes - oldest[0]!.byte_count };
          }
        });
      },
      revoke: () => binding.revoke(),
      close: () => storage!.close(),
    };
    return Object.freeze(cache);
  } catch (error) {
    if (storage) await storage.abort(); else await connection.closeAsync().catch(() => undefined);
    throw error;
  }
}
