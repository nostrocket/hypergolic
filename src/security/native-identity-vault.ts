import { MAX_IDENTITIES, VaultError, type VaultErrorCode, type VaultSnapshot } from './identity-vault-model.ts';
import { validateSignedEvent, type VerifiedSignedEvent } from './signed-event.ts';
import { uploadSigningSnapshot, type UploadSnapshot } from '../uploads/upload-snapshot.ts';
import type { EventSnapshot } from './event-snapshot.ts';
import type { EffectAuthority } from './approval-service.ts';
import { captureSigningMethods, SIGNER_FAILURE_CODES, type SigningMethodKind, type SigningMethodsSnapshot } from './signing-methods.ts';
import type { NativeSigningHandoffState, NativeImportCandidate, NativeRemoteCandidate, NativeAndroidSignerCandidate, NativeSigningSource, NativeVaultModule } from './native-vault-contract.ts';

export interface IdentityVaultPort {
  getSnapshot(): VaultSnapshot;
  prepareImport(): Promise<NativeImportCandidate | null>;
  cancelImportPreparation?(): void;
  cancelImport(candidate: NativeImportCandidate): void;
  commitImport(candidate: NativeImportCandidate): Promise<VaultSnapshot>;
  select(pubkey: string): Promise<VaultSnapshot>;
  getSigningMethods(pubkey: string): Promise<SigningMethodsSnapshot>;
  prepareRemoteConnection(): Promise<NativeRemoteCandidate | null>;
  cancelRemotePreparation(): void;
  isRemotePreparationHandoffPending(): boolean;
  cancelRemoteConnection(candidate: NativeRemoteCandidate): void;
  commitRemoteConnection(candidate: NativeRemoteCandidate): Promise<VaultSnapshot>;
  prepareRemoteRefresh(pubkey: string): Promise<NativeRemoteCandidate | null>;
  cancelRemoteRefresh(candidate: NativeRemoteCandidate): void;
  commitRemoteRefresh(candidate: NativeRemoteCandidate): Promise<VaultSnapshot>;
  prepareAndroidSigner(): Promise<NativeAndroidSignerCandidate | null>;
  cancelAndroidSigner(candidate: NativeAndroidSignerCandidate): void;
  commitAndroidSigner(candidate: NativeAndroidSignerCandidate): Promise<VaultSnapshot>;
  selectSigningMethod(pubkey: string, method: SigningMethodKind): Promise<VaultSnapshot>;
  disconnectSigningMethod(pubkey: string, method: 'nip46' | 'nip55'): Promise<VaultSnapshot>;
  deleteLocalKey(pubkey: string): Promise<VaultSnapshot>;
  cancelAction(): void;
  deleteIdentity?(pubkey: string, assertActive?: () => void): Promise<VaultSnapshot>;
}

let preparationSequence = 0;
const keyPattern = /^[0-9a-f]{64}$/;
const handlePattern = /^[A-Za-z0-9_-]{16,128}$/;
const recoverable = new Set<VaultErrorCode>(['INVALID_NSEC', 'LIMIT_REACHED', 'NOT_FOUND', 'DELETE_SELECTED', 'AUTHORIZATION_DENIED', ...SIGNER_FAILURE_CODES]);
const knownErrors = new Set<VaultErrorCode>([...recoverable, 'INVALID_SECRET', 'CORRUPT_METADATA', 'STORAGE_FAILURE',
  'READBACK_FAILED', 'RECOVERY_REQUIRED', 'NOT_READY', 'PENDING_DELETION']);
function denied(): never { throw new VaultError('AUTHORIZATION_DENIED'); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new VaultError('CORRUPT_METADATA');
  }
  return value as Record<string, unknown>;
}
function parse(raw: string, maximum = 16_384): unknown {
  if (typeof raw !== 'string' || raw.length > maximum) throw new VaultError('CORRUPT_METADATA');
  try { return JSON.parse(raw) as unknown; } catch { throw new VaultError('CORRUPT_METADATA'); }
}
export function captureNativeVaultSnapshot(raw: string): VaultSnapshot {
  const value = object(parse(raw), ['vaultId', 'revision', 'selectedPubkey', 'identities', 'pendingDeletion']);
  if (typeof value.vaultId !== 'string' || value.vaultId !== value.vaultId.trim() || !handlePattern.test(value.vaultId) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.selectedPubkey !== 'string' || value.selectedPubkey.length !== 64 || !keyPattern.test(value.selectedPubkey) ||
      value.pendingDeletion !== null || !Array.isArray(value.identities) ||
      value.identities.length < 1 || value.identities.length > MAX_IDENTITIES) throw new VaultError('CORRUPT_METADATA');
  const identities = value.identities.map(item => {
    const entry = object(item, ['pubkey', 'addedAt', 'origin', 'status']);
    if (typeof entry.pubkey !== 'string' || entry.pubkey.length !== 64 || !keyPattern.test(entry.pubkey) ||
        !Number.isSafeInteger(entry.addedAt) || (entry.addedAt as number) < 0 ||
        (entry.origin !== 'generated' && entry.origin !== 'imported' && entry.origin !== 'connected') || entry.status !== 'active') throw new VaultError('CORRUPT_METADATA');
    return Object.freeze({ pubkey: entry.pubkey, addedAt: entry.addedAt as number, origin: entry.origin, status: entry.status });
  });
  if (new Set(identities.map(item => item.pubkey)).size !== identities.length ||
      !identities.some(item => item.pubkey === value.selectedPubkey)) throw new VaultError('CORRUPT_METADATA');
  return Object.freeze({ vaultId: value.vaultId, revision: value.revision as number, selectedPubkey: value.selectedPubkey,
    identities: Object.freeze(identities), pendingDeletion: null });
}
function nativeError(error: unknown): VaultError {
  if (error instanceof VaultError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return new VaultError(typeof code === 'string' && knownErrors.has(code as VaultErrorCode) ? code as VaultErrorCode : 'STORAGE_FAILURE');
}

/** Public metadata cache; native storage, candidate handles and review own all key operations. */
export class NativeIdentityVault implements IdentityVaultPort {
  private snapshot: VaultSnapshot | null = null;
  private busy = false;
  private readonly usedAuthorities = new WeakSet<object>();
  private readonly candidates = new WeakSet<NativeImportCandidate>();
  private readonly remoteCandidates = new WeakSet<NativeRemoteCandidate>();
  private readonly refreshCandidates = new WeakSet<NativeRemoteCandidate>();
  private readonly androidCandidates = new WeakSet<NativeAndroidSignerCandidate>();
  private remotePreparation: Readonly<{ vaultId: string; revision: number; attemptId: string }> | null = null;
  readonly module: NativeVaultModule;
  constructor(module: NativeVaultModule) { this.module = module; }
  getSnapshot(): VaultSnapshot { if (!this.snapshot) throw new VaultError('NOT_READY'); return this.snapshot; }
  private activate(): void { if (this.module.activateNativeVault() !== true) denied(); }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) denied();
    this.busy = true;
    try { this.activate(); return await work(); }
    catch (error) {
      const failure = nativeError(error);
      if (!recoverable.has(failure.code)) this.snapshot = null;
      throw failure;
    } finally { this.busy = false; }
  }
  private accept(raw: string, previous?: VaultSnapshot): VaultSnapshot {
    const next = captureNativeVaultSnapshot(raw);
    if (previous && (next.vaultId !== previous.vaultId || next.revision < previous.revision ||
        (next.revision === previous.revision && JSON.stringify(next) !== JSON.stringify(previous)))) throw new VaultError('CORRUPT_METADATA');
    this.snapshot = next;
    return next;
  }
  open(): Promise<VaultSnapshot> { return this.operation(async () => this.accept(await this.module.openNativeVaultAsync())); }
  prepareImport(): Promise<NativeImportCandidate | null> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      const raw = await this.module.prepareNativeImportAsync(before.vaultId, before.revision);
      if (raw === null) return null;
      const value = object(parse(raw, 512), ['handle', 'pubkey']);
      if (typeof value.handle !== 'string' || value.handle !== value.handle.trim() || !handlePattern.test(value.handle) ||
          typeof value.pubkey !== 'string' || value.pubkey.length !== 64 || !keyPattern.test(value.pubkey)) throw new VaultError('CORRUPT_METADATA');
      const candidate = Object.freeze({ handle: value.handle, pubkey: value.pubkey });
      this.candidates.add(candidate);
      return candidate;
    });
  }
  cancelImportPreparation(): void { this.module.cancelNativeVaultAction(); }
  cancelImport(candidate: NativeImportCandidate): void {
    if (!this.candidates.delete(candidate)) return;
    this.module.cancelNativeImport(candidate.handle);
  }
  commitImport(candidate: NativeImportCandidate): Promise<VaultSnapshot> {
    return this.operation(async () => {
      if (!this.candidates.delete(candidate)) denied();
      const before = this.getSnapshot();
      const next = this.accept(await this.module.commitNativeImportAsync(candidate.handle, before.vaultId, before.revision), before);
      if (next.selectedPubkey !== candidate.pubkey) throw new VaultError('CORRUPT_METADATA');
      return next;
    });
  }
  select(pubkey: string): Promise<VaultSnapshot> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      if (!before.identities.some(item => item.pubkey === pubkey)) throw new VaultError('NOT_FOUND');
      const next = this.accept(await this.module.selectNativeIdentityAsync(pubkey, before.vaultId, before.revision), before);
      if (next.selectedPubkey !== pubkey) throw new VaultError('CORRUPT_METADATA');
      return next;
    });
  }
  getSigningMethods(pubkey: string): Promise<SigningMethodsSnapshot> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      if (!before.identities.some(identity => identity.pubkey === pubkey)) throw new VaultError('NOT_FOUND');
      const raw = await this.module.getNativeSigningMethodsAsync(pubkey, before.vaultId, before.revision);
      if (this.getSnapshot() !== before) denied();
      return captureSigningMethods(raw, before, pubkey);
    });
  }
  prepareRemoteConnection(): Promise<NativeRemoteCandidate | null> { return this.prepareSignerCandidate('connect'); }
  prepareRemoteRefresh(pubkey: string): Promise<NativeRemoteCandidate | null> { return this.prepareSignerCandidate('refresh', pubkey); }
  prepareAndroidSigner(): Promise<NativeAndroidSignerCandidate | null> {
    if (typeof this.module.prepareNativeAndroidSignerAsync !== 'function') return Promise.reject(new VaultError('SIGNER_UNSUPPORTED'));
    return this.prepareSignerCandidate('android');
  }
  private prepareSignerCandidate(kind: 'connect' | 'refresh' | 'android', refreshPubkey?: string): Promise<NativeRemoteCandidate | null> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      if (refreshPubkey !== undefined && refreshPubkey !== before.selectedPubkey) denied();
      if (preparationSequence >= Number.MAX_SAFE_INTEGER) denied();
      const attempt = Object.freeze({ vaultId: before.vaultId, revision: before.revision,
        attemptId: `remote_preparation_${++preparationSequence}` });
      this.remotePreparation = attempt;
      let raw: string | null;
      try {
        if (kind === 'android') raw = await this.module.prepareNativeAndroidSignerAsync(before.vaultId, before.revision, attempt.attemptId);
        else if (kind === 'refresh') raw = await this.module.prepareNativeRemoteRefreshAsync(refreshPubkey!, before.vaultId, before.revision, attempt.attemptId);
        else raw = await this.module.prepareNativeRemoteConnectionAsync(before.vaultId, before.revision, attempt.attemptId);
      } finally { if (this.remotePreparation === attempt) this.remotePreparation = null; }
      if (raw === null) return null;
      const value = object(parse(raw, 512), ['handle', 'pubkey']);
      if (typeof value.handle !== 'string' || value.handle !== value.handle.trim() || !handlePattern.test(value.handle) ||
          typeof value.pubkey !== 'string' || value.pubkey.length !== 64 || !keyPattern.test(value.pubkey)) throw new VaultError('CORRUPT_METADATA');
      const candidate = Object.freeze({ handle: value.handle, pubkey: value.pubkey });
      if (refreshPubkey !== undefined && candidate.pubkey !== refreshPubkey) throw new VaultError('CORRUPT_METADATA');
      const candidates = kind === 'android' ? this.androidCandidates : kind === 'refresh' ? this.refreshCandidates : this.remoteCandidates;
      candidates.add(candidate);
      return candidate;
    });
  }
  cancelAction(): void { this.module.cancelNativeVaultAction(); }
  cancelRemotePreparation(): void { this.remotePreparation = null; this.cancelAction(); }
  isRemotePreparationHandoffPending(): boolean {
    const attempt = this.remotePreparation;
    if (!attempt) return false;
    try { return this.module.nativeRemotePreparationHandoffState(attempt.vaultId, attempt.revision, attempt.attemptId) === 'pending'; }
    catch { return false; }
  }
  signingHandoffState(source: NativeSigningSource): NativeSigningHandoffState {
    try {
      const value = this.module.nativeSigningHandoffState(source.kind, source.token);
      return value === 'pending' || value === 'resumed' ? value : null;
    } catch { return null; }
  }
  cancelRemoteConnection(candidate: NativeRemoteCandidate): void {
    if (this.remoteCandidates.delete(candidate)) this.module.cancelNativeRemoteConnection(candidate.handle);
  }
  cancelRemoteRefresh(candidate: NativeRemoteCandidate): void {
    if (this.refreshCandidates.delete(candidate)) this.module.cancelNativeRemoteRefresh(candidate.handle);
  }
  cancelAndroidSigner(candidate: NativeAndroidSignerCandidate): void {
    if (this.androidCandidates.delete(candidate)) this.module.cancelNativeAndroidSigner(candidate.handle);
  }
  commitRemoteRefresh(candidate: NativeRemoteCandidate): Promise<VaultSnapshot> {
    return this.changeMethod(candidate.pubkey, async before => {
      if (!this.refreshCandidates.delete(candidate)) denied();
      const raw = await this.module.commitNativeRemoteRefreshAsync(candidate.handle, before.vaultId, before.revision);
      if (captureNativeVaultSnapshot(raw).revision !== before.revision + 1) throw new VaultError('CORRUPT_METADATA');
      return raw;
    });
  }
  commitRemoteConnection(candidate: NativeRemoteCandidate): Promise<VaultSnapshot> {
    return this.commitSignerConnection(candidate, 'nip46');
  }
  commitAndroidSigner(candidate: NativeAndroidSignerCandidate): Promise<VaultSnapshot> {
    return this.commitSignerConnection(candidate, 'nip55');
  }
  private commitSignerConnection(candidate: NativeRemoteCandidate, kind: 'nip46' | 'nip55'): Promise<VaultSnapshot> {
    return this.operation(async () => {
      if (!(kind === 'nip46' ? this.remoteCandidates : this.androidCandidates).delete(candidate)) denied();
      const before = this.getSnapshot();
      const raw = kind === 'nip46'
        ? await this.module.commitNativeRemoteConnectionAsync(candidate.handle, before.vaultId, before.revision)
        : await this.module.commitNativeAndroidSignerAsync(candidate.handle, before.vaultId, before.revision);
      const next = this.accept(raw, before);
      const existed = before.identities.some(identity => identity.pubkey === candidate.pubkey);
      if (next.selectedPubkey !== candidate.pubkey || next.revision !== before.revision + 1 ||
          next.identities.length !== before.identities.length + (existed ? 0 : 1) ||
          before.identities.some(identity => JSON.stringify(next.identities.find(item => item.pubkey === identity.pubkey)) !== JSON.stringify(identity)) ||
          (!existed && next.identities.find(identity => identity.pubkey === candidate.pubkey)?.origin !== 'connected')) {
        throw new VaultError('CORRUPT_METADATA');
      }
      return next;
    });
  }
  private changeMethod(pubkey: string, mutate: (before: VaultSnapshot) => Promise<string>): Promise<VaultSnapshot> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      if (pubkey !== before.selectedPubkey) denied();
      const next = this.accept(await mutate(before), before);
      if (next.selectedPubkey !== before.selectedPubkey || next.revision > before.revision + 1 ||
          JSON.stringify(next.identities) !== JSON.stringify(before.identities)) throw new VaultError('CORRUPT_METADATA');
      return next;
    });
  }
  selectSigningMethod(pubkey: string, method: SigningMethodKind): Promise<VaultSnapshot> {
    if (method !== 'local' && method !== 'nip46' && method !== 'nip55') return Promise.reject(new VaultError('SIGNER_UNSUPPORTED'));
    return this.changeMethod(pubkey, before => this.module.selectNativeSigningMethodAsync(pubkey, method, before.vaultId, before.revision));
  }
  disconnectSigningMethod(pubkey: string, method: 'nip46' | 'nip55'): Promise<VaultSnapshot> {
    if (method !== 'nip46' && method !== 'nip55') return Promise.reject(new VaultError('SIGNER_UNSUPPORTED'));
    return this.changeMethod(pubkey, before => this.module.disconnectNativeSigningMethodAsync(pubkey, method, before.vaultId, before.revision));
  }
  deleteLocalKey(pubkey: string): Promise<VaultSnapshot> {
    return this.changeMethod(pubkey, before => this.module.deleteNativeLocalKeyAsync(pubkey, before.vaultId, before.revision));
  }
  deleteIdentity(pubkey: string, assertActive?: () => void): Promise<VaultSnapshot> {
    return this.operation(async () => {
      const before = this.getSnapshot();
      assertActive?.();
      if (pubkey === before.selectedPubkey) throw new VaultError('DELETE_SELECTED');
      const raw = await this.module.deleteNativeIdentityAsync(pubkey, before.vaultId, before.revision);
      const next = this.accept(raw, before);
      assertActive?.();
      return next;
    });
  }
  signApproved(snapshot: EventSnapshot, authority: EffectAuthority): Promise<VerifiedSignedEvent> {
    if (snapshot.event.kind === 22242 || snapshot.event.kind === 24242 ||
        !['approval', 'fixture-manifest'].includes(authority.nativeSource?.kind ?? '')) return Promise.reject(new VaultError('AUTHORIZATION_DENIED'));
    return this.sign(snapshot, authority, ['approval', 'fixture-manifest']);
  }
  signApprovedUpload(snapshot: UploadSnapshot, authority: EffectAuthority): Promise<VerifiedSignedEvent> {
    if (!['upload', 'fixture-upload'].includes(authority.nativeSource?.kind ?? '')) return Promise.reject(new VaultError('AUTHORIZATION_DENIED'));
    return this.sign(uploadSigningSnapshot(snapshot), authority, ['upload', 'fixture-upload']);
  }
  private async sign(snapshot: EventSnapshot, authority: EffectAuthority, allowed: readonly NativeSigningSource['kind'][]): Promise<VerifiedSignedEvent> {
    const before = this.getSnapshot(), provided = authority.nativeSource;
    const source = provided ? Object.freeze({ kind: provided.kind, token: provided.token }) : null;
    if (!source || !allowed.includes(source.kind) || typeof source.token !== 'string' || source.token.length < 1 || source.token.length > 128 || this.usedAuthorities.has(authority) || snapshot.selectedPubkey !== before.selectedPubkey || authority.signal.aborted) denied();
    authority.assertActive(); this.activate(); this.usedAuthorities.add(authority);
    const cancel = () => {
      try { this.module.cancelNativeSigning(source.kind, source.token); } catch { /* Native owner lifetime independently revokes work. */ }
    };
    authority.signal.addEventListener('abort', cancel, { once: true });
    try {
      const unsigned = { ...snapshot.event, pubkey: before.selectedPubkey };
      const raw = await this.module.reviewAndSignNativeEventAsync(source.kind, source.token, JSON.stringify(unsigned), before.vaultId, before.revision);
      try { await authority.awaitForeground?.(); } catch { throw new VaultError('SIGNER_UNCERTAIN'); }
      authority.assertActive();
      if (authority.signal.aborted || this.getSnapshot() !== before) denied();
      return validateSignedEvent(snapshot, parse(raw, 2 * 1024 * 1024 + 1024));
    } catch (error) { throw nativeError(error); }
    finally { authority.signal.removeEventListener('abort', cancel); }
  }
}
