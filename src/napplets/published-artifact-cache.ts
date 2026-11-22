import { adoptNativePublishedBody, type NativePublishedBodyPort } from './native-published-body.ts';
import { createConnection, type Access, type StorageConnection } from '../storage/connection.ts';
import { fail, type RequestOptions, type SQLiteModule, type TrustedApp } from '../storage/ports.ts';
import type { NappletReference } from './resolve-link.ts';
import {matchesPublishedAppKey,snapshotEventId} from './published-identity.ts';
import {verifiedPublicationIdentity} from './verified-publication-identity.ts';
import { NappletVerificationError, assertVerifiedArtifact, nativeBodyOf, verifyPublishedBody, MAX_HTML_BYTES, MAX_MANIFEST_BYTES, verifyArtifact, verifyManifest, type VerifiedNappletArtifact } from './verified-artifact.ts';

export const PUBLISHED_ARTIFACT_CACHE_DATABASE = 'hypergolic-published-artifacts-v1.db';
export const PUBLISHED_ARTIFACT_CACHE_MAX_ROWS = 32;
export const PUBLISHED_ARTIFACT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** The epoch source must advance before an identity/session change is made visible. */
export type PublishedArtifactCacheAuthority = Readonly<{
  owner: TrustedApp;
  epoch: number;
  currentEpoch: () => number;
  nativeBodies?: NativePublishedBodyPort;
  protectedEvents?: () => ReadonlySet<string>;
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
type Row = { row_id: number; html_bytes: number; html_type: string; publisher: string; identifier: string; event_id: string; signed_event: string; html: Uint8Array; byte_count: number };
const MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;
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

async function pruneCache(io: Access, user: string, protectedEvents: () => ReadonlySet<string>) {
  const rows = await io.all<{row_id: number; event_id: string; byte_count: number}>(
    'SELECT row_id, event_id, byte_count FROM verified_published_artifacts WHERE user = ? ORDER BY row_id DESC', user);
  // Inspect pins after the read. Keep the newest cold entries within both budgets.
  const keep = protectedEvents();
  let bytes = 0, coldBytes = 0, coldRows = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.byte_count) || row.byte_count < 0 || row.byte_count > MAX_STORED_ROW_BYTES) fail('CORRUPT_STORAGE');
    if (keep.has(row.event_id)) bytes += row.byte_count;
  }
  const evicted: number[] = [];
  if (bytes > MAX_ACCOUNT_BYTES) fail('QUOTA_EXCEEDED');
  for (const row of rows) {
    if (keep.has(row.event_id)) continue;
    if (coldRows < PUBLISHED_ARTIFACT_CACHE_MAX_ROWS && coldBytes + row.byte_count <= PUBLISHED_ARTIFACT_CACHE_MAX_BYTES &&
        bytes + row.byte_count <= MAX_ACCOUNT_BYTES) {
      coldRows++; coldBytes += row.byte_count; bytes += row.byte_count;
    } else {
      evicted.push(row.row_id);
    }
  }
  if (evicted.length) {
    const placeholders = evicted.map(() => '?').join(', ');
    const deleted = await io.run(`DELETE FROM verified_published_artifacts WHERE user = ? AND row_id IN (${placeholders})`, user, ...evicted);
    if (deleted !== evicted.length) fail('STORAGE_FAILURE');
  }
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
      (!validIdentifier(owner.appId) && snapshotEventId(owner.appId) === null)) return fail('INVALID_INPUT');
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
  const bodies = authority.nativeBodies;
  const connection = await sqlite.openDatabaseAsync(PUBLISHED_ARTIFACT_CACHE_DATABASE, { useNewConnection: true, enableChangeListener: false });
  try {
    assertIdentity();
    await connection.execAsync('PRAGMA busy_timeout = 1500');
    await connection.execAsync('PRAGMA journal_mode = WAL');
    await connection.execAsync('PRAGMA synchronous = FULL');
    storage = createConnection(connection);
    const binding = storage.lease(assertIdentity);
    await binding.submit(undefined, check => storage!.transaction(check, initialize));
    const request = <T>(options: RequestOptions | undefined, action: (io: Access) => Promise<T>, bodyFile?: string) => {
      assertOpen();
      return binding.submit(options, async check => {
        if (!bodyFile) return storage!.transaction(check, action);
        await connection.runAsync('ATTACH DATABASE ? AS body_store', bodyFile);
        try { return await storage!.transaction(check, action); }
        finally {
          try { await connection.execAsync('DETACH DATABASE body_store'); }
          catch { await storage!.abort(); fail('STORAGE_FAILURE'); }
        }
      });
    };
    const cache: PublishedArtifactCache = {
      get: async (identifier, eventId, options) => {
        assertOpen();
        if (identifier !== appId || !HEX64.test(eventId) || !matchesPublishedAppKey(identifier,eventId)) return fail('INVALID_INPUT');
        const rows = await request(options, io => io.all<Row>(
          `SELECT publisher, identifier, event_id, row_id, signed_event, ${bodies ? '' : 'html,'} length(html) AS html_bytes,
            typeof(html) AS html_type, byte_count FROM verified_published_artifacts WHERE user = ? AND publisher = ? AND identifier = ? AND event_id = ?`,
          user, publisher, identifier, eventId));
        if (rows.length === 0) return null;
        const row = rows[0]!;
        try {
          assertOpen();
          if (rows.length !== 1 || row.publisher !== publisher || row.identifier !== identifier || row.event_id !== eventId ||
              typeof row.signed_event !== 'string' || new TextEncoder().encode(row.signed_event).byteLength > MAX_MANIFEST_BYTES ||
              row.html_type !== 'blob' || !Number.isSafeInteger(row.html_bytes) || row.html_bytes < 1 || row.html_bytes > MAX_HTML_BYTES ||
              row.byte_count !== new TextEncoder().encode(row.signed_event).byteLength + row.html_bytes || row.byte_count > MAX_STORED_ROW_BYTES) fail('CORRUPT_STORAGE');
          const coordinate: NappletReference = snapshotEventId(identifier)
            ? Object.freeze({kind:5129,pubkey:publisher,eventId})
            : Object.freeze({ kind: 35129, pubkey: publisher, identifier, relayHints: Object.freeze([]) });
          const event: unknown = JSON.parse(row.signed_event);
          assertOpen();
          const manifest = await verifyManifest(coordinate, event);
          assertOpen();
          if (manifest.pubkey !== publisher || manifest.id !== eventId || manifest.eventId !== eventId) return null;
          if (bodies) {
            const token = await bodies.createPublishedBodyToken();
            let retained = false;
            try {
              const file = await bodies.publishedBodyDatabase(token, user, row.html_bytes);
              await request(options, async io => {
                const copied = await io.run(`INSERT INTO body_store.payload (id, body)
                  SELECT 1, html FROM main.verified_published_artifacts
                  WHERE row_id = ? AND user = ? AND publisher = ? AND identifier = ? AND event_id = ? AND signed_event = ?`,
                  row.row_id, user, publisher, identifier, eventId, row.signed_event);
                if (copied !== 1) fail('CONFLICT');
              }, file);
              assertOpen();
              const length = await bodies.verifyCachedPublishedBody(token, manifest.expectedHtmlHash);
              assertOpen();
              if (options?.signal?.aborted) fail('CANCELLED');
              if (length === -2 || length === -3) fail('CORRUPT_STORAGE');
              if (length !== row.html_bytes) fail('STORAGE_FAILURE');
              const artifact = await verifyPublishedBody(manifest, adoptNativePublishedBody(bodies, token, manifest.expectedHtmlHash, length));
              assertOpen();
              retained = true;
              return artifact;
            } finally { if (!retained) bodies.releasePublishedBody(token); }
          }
          const artifact = await verifyArtifact(manifest, new Uint8Array(row.html));
          assertOpen();
          return artifact;
        } catch (error) {
          assertOpen();
          const code = (error as {code?: string})?.code;
          if (code === 'CONFLICT') return null;
          if (code !== 'CORRUPT_STORAGE' && !(error instanceof NappletVerificationError) && !(error instanceof SyntaxError)) throw error;
          // Persistent bytes are untrusted. Remove a corrupt entry and let the caller fetch afresh.
          await request(options, io => io.run('DELETE FROM verified_published_artifacts WHERE row_id = ? AND user = ? AND publisher = ? AND identifier = ? AND event_id = ?', row.row_id, user, publisher, identifier, eventId));
          return null;
        }
      },
      put: async (artifactInput, options) => {
        assertOpen(); assertVerifiedArtifact(artifactInput);
        const artifact: VerifiedNappletArtifact = artifactInput;
        const identifier = verifiedPublicationIdentity(artifact.manifest).appId;
        if (artifact.manifest.pubkey !== publisher || identifier !== appId ||
            !HEX64.test(artifact.manifest.eventId)) return fail('INVALID_INPUT');
        const signedEvent = JSON.stringify(eventFrom(artifact));
        const eventBytes = new TextEncoder().encode(signedEvent);
        const byteCount = eventBytes.byteLength + artifact.htmlByteLength;
        if (eventBytes.byteLength > MAX_MANIFEST_BYTES || artifact.htmlByteLength > MAX_HTML_BYTES || byteCount > MAX_STORED_ROW_BYTES) return fail('QUOTA_EXCEEDED');
        const body = nativeBodyOf(artifact);
        if (body && !bodies) return fail('STORAGE_FAILURE');
        const file = body ? await bodies!.publishedBodyDatabase(body.token, user, body.byteLength) : undefined;
        await request(options, async io => {
          await io.run('DELETE FROM verified_published_artifacts WHERE user = ? AND publisher = ? AND identifier = ? AND event_id = ?',
            user, publisher, identifier, artifact.manifest.eventId);
          if (body) {
            const copied = await io.run(`INSERT INTO verified_published_artifacts (user, publisher, identifier, event_id, signed_event, html, byte_count)
              SELECT ?, ?, ?, ?, ?, body, ? FROM body_store.payload WHERE id = 1 AND length(body) = ?`,
              user, publisher, identifier, artifact.manifest.eventId, signedEvent, byteCount, body.byteLength);
            if (copied !== 1) fail('STORAGE_FAILURE');
          } else {
            await io.run(`INSERT INTO verified_published_artifacts (user, publisher, identifier, event_id, signed_event, html, byte_count)
              VALUES (?, ?, ?, ?, ?, ?, ?)`, user, publisher, identifier, artifact.manifest.eventId, signedEvent, artifact.htmlBytes, byteCount);
          }
          await pruneCache(io, user, authority.protectedEvents ?? (() => new Set()));
        }, file);
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
