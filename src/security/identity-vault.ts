import { validateSignedEvent, type VerifiedSignedEvent } from './signed-event.ts';
import { uploadSigningSnapshot, type UploadSnapshot } from '../uploads/upload-snapshot.ts';
import type { EventSnapshot } from './event-snapshot.ts';
import type { EffectAuthority } from './approval-service.ts';
import { database, fields, freezeInventory, integer, inventory, MAX_IDENTITIES, nextInventory, opaqueId, pubkey, record, same, sameSecret, VaultError, wipeReturned, type DatabaseRecord, type Inventory, type Pending, type SecretRecord, type StagedSecret, type VaultSnapshot } from './identity-vault-model.ts';
export { MAX_IDENTITIES, VaultError } from './identity-vault-model.ts';
export type { DatabaseRecord, Identity, Inventory, Pending, SecretRecord, StagedSecret, VaultErrorCode, VaultSnapshot } from './identity-vault-model.ts';

/** Every read rejects on an I/O/decryption error. null means a successful absent read only. */
export interface EncryptedSecrets {
  readInventory(): Promise<unknown | null>;
  writeInventory(value: Inventory): Promise<void>;
  readStage(): Promise<unknown | null>;
  writeStage(value: StagedSecret): Promise<void>;
  deleteStage(): Promise<void>;
  readSecret(pubkey: string): Promise<unknown | null>;
  writeSecret(pubkey: string, value: SecretRecord): Promise<void>;
  deleteSecret(pubkey: string, grant: DeletionGrant): Promise<void>;
}
/** SQLite implements CAS and the whole record write in one durable transaction. No secrets. */
export interface MetadataDatabase {
  read(): Promise<unknown | null>;
  compareAndSwap(expectedRevision: number | null, next: DatabaseRecord): Promise<void>;
}
export interface DeletionGrant { assertActive(): void }
export interface VaultDependencies {
  database: MetadataDatabase;
  secrets: EncryptedSecrets;
  generateSecretKey(): Uint8Array | Promise<Uint8Array>;
  parseNsec(value: string): Uint8Array;
  derivePublicKey(secretKey: Uint8Array): string;
  newId(): string;
  now(): number;
  /** Native owner authenticates exact target/selection/revision and supplies a revocable one-shot grant. */
  authorizeDeletion(request: Readonly<{ pubkey: string; selectedPubkey: string; revision: number }>): Promise<DeletionGrant>;
}
export type ApprovedEventSigner = (event: { kind: number; content: string; tags: string[][]; created_at: number }, secretKey: Uint8Array) => unknown;

/** One native owner instance per process. Public operations are serialized. */
export class IdentityVault {
  private readonly deps: VaultDependencies;
  private tail: Promise<unknown> = Promise.resolve();
  private db: DatabaseRecord | null = null;
  private ready = false;
  private readonly usedAuthorities = new WeakSet<object>();
  constructor(dependencies: VaultDependencies) { this.deps = dependencies; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (!(error instanceof VaultError) || ['STORAGE_FAILURE', 'READBACK_FAILED', 'RECOVERY_REQUIRED', 'CORRUPT_METADATA', 'INVALID_SECRET'].includes(error.code)) this.ready = false;
      throw error instanceof VaultError ? error : new VaultError('STORAGE_FAILURE');
    }
  }
  private id(): string { const id = this.deps.newId(); if (!opaqueId(id)) throw new VaultError('CORRUPT_METADATA'); return id; }
  private now(): number { const now = this.deps.now(); if (!integer(now)) throw new VaultError('CORRUPT_METADATA'); return now; }
  private snapshot(): VaultSnapshot {
    const inv = this.db?.inventory;
    if (!this.ready || !inv?.initialized || !inv.selectedPubkey) throw new VaultError('NOT_READY');
    const deleting = this.db?.pending?.kind === 'delete' ? this.db.pending.pubkey : null;
    return Object.freeze({ vaultId: inv.vaultId, revision: inv.revision, selectedPubkey: inv.selectedPubkey,
      identities: Object.freeze(inv.identities.map(i => Object.freeze({ ...i, status: i.pubkey === deleting ? 'deleting' as const : 'active' as const }))), pendingDeletion: deleting });
  }
  getSnapshot(): VaultSnapshot { return this.snapshot(); }
  private requireReady(allowDelete = false): DatabaseRecord {
    this.snapshot();
    if (!this.db) throw new VaultError('NOT_READY');
    if (this.db.pending && !(allowDelete && this.db.pending.kind === 'delete')) throw new VaultError('PENDING_DELETION');
    return this.db;
  }
  private secret(value: unknown, expected?: string): SecretRecord {
    const x = record(value);
    if (x.schema !== 1 || !pubkey(x.pubkey) || !(x.secretKey instanceof Uint8Array) || x.secretKey.length !== 32 || (expected && x.pubkey !== expected)) throw new VaultError('INVALID_SECRET');
    const bytes = new Uint8Array(x.secretKey);
    try {
      const derived = this.deps.derivePublicKey(bytes);
      if (!pubkey(derived) || derived !== x.pubkey) throw new VaultError('INVALID_SECRET');
      return { schema: 1, pubkey: derived, secretKey: new Uint8Array(bytes) };
    } catch { throw new VaultError('INVALID_SECRET'); }
    finally { bytes.fill(0); }
  }
  private candidate(bytes: Uint8Array): SecretRecord {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new VaultError('INVALID_SECRET');
    const copy = new Uint8Array(bytes);
    try {
      const key = this.deps.derivePublicKey(copy);
      if (!pubkey(key)) throw new VaultError('INVALID_SECRET');
      return { schema: 1, pubkey: key, secretKey: new Uint8Array(copy) };
    } catch { throw new VaultError('INVALID_SECRET'); }
    finally { copy.fill(0); }
  }
  private stage(value: unknown): StagedSecret {
    try {
      const x = record(value); fields(x, ['schema', 'pubkey', 'secretKey', 'vaultId', 'kind', 'addedAt']);
      if (!opaqueId(x.vaultId) || !['initialize', 'import'].includes(String(x.kind)) || !integer(x.addedAt)) throw new VaultError('INVALID_SECRET');
      return { ...this.secret(value), vaultId: x.vaultId, kind: x.kind as StagedSecret['kind'], addedAt: x.addedAt };
    } finally { wipeReturned(value); }
  }
  private async readSecret(key: string): Promise<SecretRecord | null> {
    const value = await this.deps.secrets.readSecret(key);
    if (value === null) return null;
    try { fields(record(value), ['schema', 'pubkey', 'secretKey']); return this.secret(value, key); }
    finally { wipeReturned(value); }
  }
  private assertSigningAuthority(authority: { assertActive(): void }): void {
    try { authority.assertActive(); } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
  }
  private async verifySigningState(expected: VaultSnapshot, authority: { assertActive(): void }): Promise<void> {
    this.assertSigningAuthority(authority);
    const current = this.requireReady();
    if (current.inventory.selectedPubkey !== expected.selectedPubkey || current.inventory.revision !== expected.revision || current.pending?.kind === 'delete') {
      throw new VaultError('AUTHORIZATION_DENIED');
    }
    const [inventoryRead, databaseRead] = await Promise.all([this.deps.secrets.readInventory(), this.deps.database.read()]);
    this.assertSigningAuthority(authority);
    if (inventoryRead === null || databaseRead === null) throw new VaultError('RECOVERY_REQUIRED');
    if (!same(inventory(inventoryRead), current.inventory) || !same(database(databaseRead), current)) {
      throw new VaultError('CORRUPT_METADATA', 'Protected inventory and database disagree');
    }
  }
  private async verifyKeys(inv: Inventory, except?: string): Promise<void> {
    const reads = inv.identities.map(async identity => {
      if (identity.pubkey === except) return;
      const value = await this.readSecret(identity.pubkey);
      if (!value) throw new VaultError('RECOVERY_REQUIRED', 'Established identity secret is missing');
      value.secretKey.fill(0);
    });
    // Drain every read and wipe its result before releasing the vault operation lock.
    const results = await Promise.allSettled(reads);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  private async writeDb(inv: Inventory, p: Pending | null): Promise<void> {
    const expected = this.db?.revision ?? null;
    if (expected === Number.MAX_SAFE_INTEGER) throw new VaultError('CORRUPT_METADATA');
    const next = database({ revision: expected === null ? 0 : expected + 1, inventory: inv, pending: p });
    try { await this.deps.database.compareAndSwap(expected, next); } catch { /* Readback determines whether an uncertain write committed. */ }
    const raw = await this.deps.database.read();
    if (raw === null || !same(database(raw), next)) throw new VaultError('READBACK_FAILED', 'Metadata write was not confirmed');
    this.db = next;
  }
  private async writeInventory(inv: Inventory): Promise<void> {
    try { await this.deps.secrets.writeInventory(inv); } catch { /* Readback is authoritative. */ }
    const raw = await this.deps.secrets.readInventory();
    if (raw === null || !same(inventory(raw), inv)) throw new VaultError('READBACK_FAILED', 'Protected inventory write was not confirmed');
  }
  private async writeStage(stage: StagedSecret): Promise<void> {
    const copy = { ...stage, secretKey: new Uint8Array(stage.secretKey) };
    try {
      try { await this.deps.secrets.writeStage(copy); } catch { /* Verify uncertain writes. */ }
      const raw = await this.deps.secrets.readStage();
      if (raw === null) throw new VaultError('READBACK_FAILED');
      const saved = this.stage(raw);
      try {
        if (saved.vaultId !== stage.vaultId || saved.kind !== stage.kind || saved.addedAt !== stage.addedAt || saved.pubkey !== stage.pubkey || !sameSecret(saved.secretKey, stage.secretKey)) throw new VaultError('READBACK_FAILED');
      } finally { saved.secretKey.fill(0); }
    } finally { copy.secretKey.fill(0); }
  }
  private async ensureSecret(stage: StagedSecret): Promise<void> {
    const existing = await this.readSecret(stage.pubkey);
    if (existing) { existing.secretKey.fill(0); return; } // Preserve an existing valid envelope, including x-only equivalent scalars.
    const copy = { schema: 1 as const, pubkey: stage.pubkey, secretKey: new Uint8Array(stage.secretKey) };
    try {
      try { await this.deps.secrets.writeSecret(stage.pubkey, copy); } catch { /* Verify uncertain write. */ }
      const saved = await this.readSecret(stage.pubkey);
      if (!saved) throw new VaultError('READBACK_FAILED');
      try { if (!sameSecret(saved.secretKey, stage.secretKey)) throw new VaultError('READBACK_FAILED'); }
      finally { saved.secretKey.fill(0); }
    } finally { copy.secretKey.fill(0); }
  }
  private async clearStage(): Promise<void> {
    try { await this.deps.secrets.deleteStage(); } catch { /* Verify absence. */ }
    const raw = await this.deps.secrets.readStage();
    if (raw !== null) { const value = this.stage(raw); value.secretKey.fill(0); throw new VaultError('READBACK_FAILED', 'Staging cleanup was not confirmed'); }
  }
  private async commit(inv: Inventory): Promise<void> { await this.writeInventory(inv); await this.writeDb(inv, null); }
  private added(base: Inventory, s: StagedSecret, select: boolean): Inventory {
    if (base.identities.length >= MAX_IDENTITIES) throw new VaultError('LIMIT_REACHED');
    return nextInventory(base, { initialized: true, selectedPubkey: select ? s.pubkey : base.selectedPubkey,
      identities: [...base.identities, { pubkey: s.pubkey, addedAt: s.addedAt, origin: s.kind === 'initialize' ? 'generated' : 'imported' }] });
  }
  private async finishAdd(s: StagedSecret, recovery: boolean): Promise<void> {
    if (!this.db || this.db.inventory.vaultId !== s.vaultId) throw new VaultError('RECOVERY_REQUIRED');
    const p = this.db.pending;
    if (!p || p.kind !== s.kind || (p.kind === 'import' && p.pubkey !== s.pubkey) || !('addedAt' in p) || p.addedAt !== s.addedAt) throw new VaultError('RECOVERY_REQUIRED');
    await this.verifyKeys(this.db.inventory);
    await this.ensureSecret(s);
    await this.commit(this.added(this.db.inventory, s, s.kind === 'initialize' || !recovery));
    await this.clearStage();
  }
  private receiptAllowed(receipt: Inventory | null, ...allowed: Inventory[]): void {
    if (receipt === null || !allowed.some(i => same(receipt, i))) throw new VaultError('RECOVERY_REQUIRED', 'Protected inventory and database disagree');
  }
  private async load(): Promise<{ receipt: Inventory | null; stage: StagedSecret | null }> {
    // Read all absence indicators successfully before any mutation or generation.
    const reads = await Promise.allSettled([this.deps.database.read(), this.deps.secrets.readInventory(), this.deps.secrets.readStage()]);
    const [dbRead, invRead, stageRead] = reads;
    if (!dbRead || !invRead || !stageRead || dbRead.status === 'rejected' || invRead.status === 'rejected' || stageRead.status === 'rejected') {
      if (stageRead?.status === 'fulfilled') wipeReturned(stageRead.value);
      throw new VaultError('STORAGE_FAILURE');
    }
    const [db, inv, stage] = [dbRead.value, invRead.value, stageRead.value];
    try {
      this.db = db === null ? null : database(db);
      return { receipt: inv === null ? null : inventory(inv), stage: stage === null ? null : this.stage(stage) };
    } finally { wipeReturned(stage); }
  }
  open(): Promise<VaultSnapshot> { return this.serial(() => this.guarded(async () => {
    this.ready = false;
    const state = await this.load();
    try {
      if (!this.db) {
        if (state.receipt || state.stage) throw new VaultError('RECOVERY_REQUIRED', 'Surviving protected state requires explicit database recovery');
        const initial: Inventory = freezeInventory({ schema: 1, vaultId: this.id(), revision: 0, initialized: false, selectedPubkey: null, identities: [] });
        await this.writeDb(initial, { kind: 'initialize', operationId: this.id(), addedAt: this.now() });
        await this.writeInventory(initial);
        const generated = await this.deps.generateSecretKey();
        try {
          const candidate = this.candidate(generated);
          const staged: StagedSecret = { ...candidate, vaultId: initial.vaultId, kind: 'initialize', addedAt: (this.db!.pending as Extract<Pending, {kind:'initialize'}>).addedAt };
          try { await this.writeStage(staged); await this.finishAdd(staged, false); }
          finally { staged.secretKey.fill(0); }
        } finally { generated.fill(0); }
      } else await this.recoverPending(state.receipt, state.stage);
      this.ready = true;
      return this.snapshot();
    } finally { state.stage?.secretKey.fill(0); }
  })); }
  private async recoverPending(receipt: Inventory | null, s: StagedSecret | null): Promise<void> {
    const db = this.db!;
    const base = db.inventory, p = db.pending;
    if (s && s.vaultId !== base.vaultId) throw new VaultError('RECOVERY_REQUIRED');
    if (!p) {
      this.receiptAllowed(receipt, base);
      await this.verifyKeys(base);
      if (s) {
        if (!base.identities.some(i => i.pubkey === s.pubkey)) throw new VaultError('RECOVERY_REQUIRED', 'Untracked staged identity');
        await this.clearStage();
      }
      return;
    }
    if (p.kind === 'initialize' || p.kind === 'import') {
      if (!s) {
        if (p.kind === 'initialize') throw new VaultError('RECOVERY_REQUIRED', 'Initialization is incomplete; no staged key may be replaced');
        this.receiptAllowed(receipt, base);
        // No staged write can precede a secret write in this implementation.
        const existing = await this.readSecret(p.pubkey);
        if (existing) { existing.secretKey.fill(0); throw new VaultError('RECOVERY_REQUIRED', 'Untracked import secret'); }
        await this.verifyKeys(base);
        await this.writeDb(base, null);
        return;
      }
      this.receiptAllowed(receipt, base, this.added(base, s, true), this.added(base, s, p.kind === 'initialize'));
      await this.finishAdd(s, true); // Interrupted imports become saved, unselected identities.
      return;
    }
    if (s) throw new VaultError('RECOVERY_REQUIRED', 'Unexpected staged secret during selection or deletion');
    if (p.kind === 'select') {
      this.receiptAllowed(receipt, base, nextInventory(base, { selectedPubkey: p.pubkey }), nextInventory(base, {}));
      await this.verifyKeys(base);
      // The DB commit is the selection commit point. Roll back a prepared selection.
      await this.commit(nextInventory(base, {}));
      return;
    }
    const next = nextInventory(base, { identities: base.identities.filter(i => i.pubkey !== p.pubkey) });
    this.receiptAllowed(receipt, base, next);
    await this.verifyKeys(base, p.pubkey);
    const target = await this.readSecret(p.pubkey);
    if (target) {
      target.secretKey.fill(0);
      this.receiptAllowed(receipt, base);
      return; // Tombstone remains. A fresh device-auth grant is required to retry deletion.
    }
    await this.commit(next); // Erasure happened; metadata cleanup needs no new secret action.
  }
  /** Explicit user-facing recovery route; ordinary open never recreates a missing database. */
  recoverMissingDatabase(): Promise<VaultSnapshot> { return this.serial(() => this.guarded(async () => {
    this.ready = false;
    const { receipt, stage } = await this.load();
    try {
      if (this.db || !receipt?.initialized) throw new VaultError('RECOVERY_REQUIRED');
      await this.verifyKeys(receipt);
      if (stage && stage.vaultId !== receipt.vaultId) throw new VaultError('RECOVERY_REQUIRED');
      if (stage && !receipt.identities.some(i => i.pubkey === stage.pubkey)) {
        if (stage.kind !== 'import') throw new VaultError('RECOVERY_REQUIRED');
        await this.writeDb(receipt, { kind: 'import', operationId: this.id(), addedAt: stage.addedAt, pubkey: stage.pubkey });
        await this.finishAdd(stage, true);
      } else {
        await this.writeDb(receipt, null);
        if (stage) await this.clearStage();
      }
      this.ready = true;
      return this.snapshot();
    } finally { stage?.secretKey.fill(0); }
  })); }
  importNsec(input: string): Promise<VaultSnapshot> { return this.serial(() => this.guarded(async () => {
    const base = this.requireReady().inventory;
    if (typeof input !== 'string' || input.trim().length > 256 || !/^nsec1/i.test(input.trim())) throw new VaultError('INVALID_NSEC');
    let parsed: Uint8Array;
    try { parsed = this.deps.parseNsec(input.trim()); } catch { throw new VaultError('INVALID_NSEC'); }
    let candidate: SecretRecord;
    try { candidate = this.candidate(parsed); }
    catch { throw new VaultError('INVALID_NSEC'); }
    finally { if (parsed instanceof Uint8Array) parsed.fill(0); }
    try {
      if (base.identities.some(i => i.pubkey === candidate.pubkey)) return await this.selectInternal(candidate.pubkey);
      if (base.identities.length >= MAX_IDENTITIES) throw new VaultError('LIMIT_REACHED');
      const stage: StagedSecret = { ...candidate, vaultId: base.vaultId, kind: 'import', addedAt: this.now() };
      await this.writeDb(base, { kind: 'import', operationId: this.id(), addedAt: stage.addedAt, pubkey: candidate.pubkey });
      await this.writeStage(stage);
      await this.finishAdd(stage, false);
      return this.snapshot();
    } finally { candidate.secretKey.fill(0); }
  })); }
  select(key: string): Promise<VaultSnapshot> { return this.serial(() => this.guarded(() => this.selectInternal(key))); }
  private async selectInternal(key: string): Promise<VaultSnapshot> {
    const base = this.requireReady().inventory;
    if (!base.identities.some(i => i.pubkey === key)) throw new VaultError('NOT_FOUND');
    const selected = await this.readSecret(key);
    if (!selected) throw new VaultError('RECOVERY_REQUIRED', 'Selected identity secret is missing');
    selected.secretKey.fill(0);
    if (base.selectedPubkey === key) return this.snapshot();
    await this.writeDb(base, { kind: 'select', operationId: this.id(), pubkey: key });
    await this.commit(nextInventory(base, { selectedPubkey: key }));
    return this.snapshot();
  }
  /** Signs only an immutable, approved snapshot with the currently selected protected identity. */
  async signApproved(snapshot: EventSnapshot, authority: EffectAuthority, signer: ApprovedEventSigner): Promise<VerifiedSignedEvent> {
    if (snapshot.event.kind === 22242 || snapshot.event.kind === 24242) throw new VaultError('AUTHORIZATION_DENIED');
    return this.signCaptured(snapshot, authority, signer);
  }
  /** Blossom credentials require an owning reviewed upload, never the ordinary relay signing lane. */
  async signApprovedUpload(snapshot: UploadSnapshot, authority: EffectAuthority, signer: ApprovedEventSigner): Promise<VerifiedSignedEvent> {
    let event: EventSnapshot;
    try { event = uploadSigningSnapshot(snapshot); }
    catch { throw new VaultError('AUTHORIZATION_DENIED'); }
    return this.signCaptured(event, authority, signer);
  }
  private async signCaptured(snapshot: EventSnapshot, authority: EffectAuthority, signer: ApprovedEventSigner): Promise<VerifiedSignedEvent> {
    const expected = this.snapshot();
    return this.serial(() => this.guarded(async () => {
      if (snapshot.selectedPubkey !== expected.selectedPubkey || typeof signer !== 'function') throw new VaultError('AUTHORIZATION_DENIED');
      this.assertSigningAuthority(authority);
      if (this.usedAuthorities.has(authority)) throw new VaultError('AUTHORIZATION_DENIED');
      this.usedAuthorities.add(authority);
      let protectedSecret: SecretRecord | null = null;
      try {
        await this.verifySigningState(expected, authority);
        protectedSecret = await this.readSecret(expected.selectedPubkey);
        this.assertSigningAuthority(authority);
        if (!protectedSecret) throw new VaultError('RECOVERY_REQUIRED', 'Selected identity secret is missing');
        await this.verifySigningState(expected, authority);
        const event = { kind: snapshot.event.kind, content: snapshot.event.content, tags: snapshot.event.tags.map(tag => [...tag]), created_at: snapshot.event.created_at };
        this.assertSigningAuthority(authority);
        const signingSecret = new Uint8Array(protectedSecret.secretKey);
        let result: unknown;
        try { result = signer(event, signingSecret); }
        finally { signingSecret.fill(0); }
        this.assertSigningAuthority(authority);
        return validateSignedEvent(snapshot, result);
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw new VaultError('STORAGE_FAILURE');
      } finally { protectedSecret?.secretKey.fill(0); }
    }));
  }
  /** Only inactive identities may be deleted; choose and validate a replacement first. */
  deleteIdentity(key: string, assertActive?: () => void): Promise<VaultSnapshot> { return this.serial(() => this.guarded(async () => {
    const current = this.requireReady(true), base = current.inventory;
    if (current.pending && (current.pending.kind !== 'delete' || current.pending.pubkey !== key)) throw new VaultError('PENDING_DELETION');
    if (!base.identities.some(i => i.pubkey === key)) throw new VaultError('NOT_FOUND');
    if (key === base.selectedPubkey || base.identities.length < 2) throw new VaultError('DELETE_SELECTED');
    await this.verifyKeys(base, key);
    let grant: DeletionGrant;
    try {
      assertActive?.();
      grant = await this.deps.authorizeDeletion(Object.freeze({ pubkey: key, selectedPubkey: base.selectedPubkey!, revision: base.revision }));
      assertActive?.(); grant.assertActive();
    } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
    if (!current.pending) await this.writeDb(base, { kind: 'delete', operationId: this.id(), pubkey: key });
    try { assertActive?.(); grant.assertActive(); } catch { throw new VaultError('AUTHORIZATION_DENIED'); }
    let deniedAtEffect = false;
    try { await this.deps.secrets.deleteSecret(key, grant); } catch (error) {
      if (error instanceof VaultError && error.code === 'READBACK_FAILED') throw error;
      deniedAtEffect = error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED';
      // Other legacy transport outcomes still need the core's absence check.
    }
    const remaining = await this.readSecret(key);
    if (remaining) {
      remaining.secretKey.fill(0);
      throw new VaultError(deniedAtEffect ? 'AUTHORIZATION_DENIED' : 'READBACK_FAILED');
    }
    if (deniedAtEffect) throw new VaultError('READBACK_FAILED');
    await this.commit(nextInventory(base, { identities: base.identities.filter(i => i.pubkey !== key) }));
    return this.snapshot();
  })); }
}
