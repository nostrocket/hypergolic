import { VaultError, type VaultSnapshot } from './identity-vault-model.ts';
import type { IdentityVaultPort } from './native-identity-vault.ts';
import { isSignerFailureCode, SIGNER_FAILURE_CODES, type SignerFailureCode, type SigningMethodKind } from './signing-methods.ts';
import type { NativeImportCandidate, NativeRemoteCandidate } from './native-vault-contract.ts';
import type { ShellDatabase } from '../storage/database.ts';
import { openWorkspaceController, type WorkspaceController } from '../storage/workspace-controller.ts';
import type { Workspace } from '../shell/workspace.ts';
import { isExpectedDeletion } from './identity-deletion.ts';

export type IdentityChange = Readonly<
  | { pubkey: string; kind: 'import' | 'select' | 'connect' | 'connect-android' | 'refresh-remote' | 'delete-local-key' }
  | { pubkey: string; kind: 'select-method'; method: SigningMethodKind }
  | { pubkey: string; kind: 'disconnect-method'; method: 'nip46' | 'nip55' }
>;
export interface IdentitySession {
  readonly vault: VaultSnapshot;
  readonly workspace: WorkspaceController;
  readonly epoch: number;
}
export interface TransitionSnapshot {
  readonly phase: 'ready' | 'confirming' | 'switching' | 'deleting' | 'recovery';
  readonly session: IdentitySession;
  readonly pending: IdentityChange | null;
  readonly failure: 'CHANGE_REJECTED' | 'LIMIT_REACHED' | 'DELETION_REJECTED' | 'DELETION_PENDING' | SignerFailureCode | null;
}
export interface TransitionPorts {
  readonly vault: IdentityVaultPort;
  readonly database: ShellDatabase;
  readonly seed: () => Workspace;
  readonly assertAvailable: (workspace: Workspace) => void;
}
export class IdentityChangeError extends Error {
  readonly code: 'BUSY' | 'STALE' | 'RECOVERY_REQUIRED';
  constructor(code: IdentityChangeError['code']) { super(code); this.code = code; this.name = 'IdentityChangeError'; }
}

/** Trusted workspace transitions use public native candidates; no secret enters JavaScript. */
export class IdentityTransition {
  private state!: TransitionSnapshot;
  private candidate: NativeImportCandidate | null = null;
  private remoteCandidate: NativeRemoteCandidate | null = null;
  private preparationGeneration = 0;
  private preparing: 'import' | 'connect' | null = null;
  private activeChange: { session: IdentitySession; cancelled: boolean } | null = null;
  private activeDeletion: { session: IdentitySession; cancelled: boolean } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly ports: TransitionPorts;
  private constructor(ports: TransitionPorts) { this.ports = ports; }
  static async open(ports: TransitionPorts): Promise<IdentityTransition> {
    const owner = new IdentityTransition(ports);
    const vault = ports.vault.getSnapshot();
    const workspace = await owner.openWorkspace(vault, 0, ports.seed);
    owner.state = Object.freeze({ phase: 'ready', session: Object.freeze({ vault, workspace, epoch: 0 }), pending: null, failure: null });
    return owner;
  }
  getSnapshot = (): TransitionSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(phase: TransitionSnapshot['phase'], session = this.state.session, pending: IdentityChange | null = null, failure: TransitionSnapshot['failure'] = null): void {
    this.state = Object.freeze({ phase, session, pending, failure });
    for (const listener of this.listeners) listener();
  }
  private async openWorkspace(vault: VaultSnapshot, epoch: number, seed: () => Workspace): Promise<WorkspaceController> {
    const binding = this.ports.database.bindWorkspace({ user: vault.selectedPubkey, assertActive: () => {
      const actual = this.ports.vault.getSnapshot();
      const accepted = this.state?.session;
      const revision = accepted?.epoch === epoch ? accepted.vault.revision : vault.revision;
      if (actual.vaultId !== vault.vaultId || actual.selectedPubkey !== vault.selectedPubkey || actual.revision !== revision ||
          (this.state && this.state.session.epoch > epoch)) throw new IdentityChangeError('STALE');
    } });
    return openWorkspaceController(binding, seed, this.ports.assertAvailable);
  }
  private requireReady(): void { if (this.state.phase !== 'ready' || this.preparing !== null) throw new IdentityChangeError('BUSY'); }
  private prepare(pending: IdentityChange): IdentityChange | null {
    if (pending.kind === 'select' && pending.pubkey === this.state.session.vault.selectedPubkey) return null;
    const captured = Object.freeze({ ...pending });
    this.publish('confirming', this.state.session, captured);
    return captured;
  }
  prepareSelect(pubkey: string): IdentityChange | null {
    this.requireReady();
    if (!this.state.session.vault.identities.some(identity => identity.pubkey === pubkey && identity.status === 'active')) throw new VaultError('NOT_FOUND');
    return this.prepare({ pubkey, kind: 'select' });
  }
  async prepareImport(): Promise<IdentityChange | null> {
    this.requireReady();
    const previous = this.state.session;
    const generation = ++this.preparationGeneration;
    this.preparing = 'import';
    let candidate: NativeImportCandidate | null = null;
    try {
      candidate = await this.ports.vault.prepareImport();
      if (!candidate) return null;
      const known = this.state.session.vault.identities.some(identity => identity.pubkey === candidate!.pubkey);
      const methods = known ? await this.ports.vault.getSigningMethods(candidate.pubkey) : null;
      if (generation !== this.preparationGeneration || this.state.phase !== 'ready') return null;
      if (methods?.selectedMethod === 'local') return this.prepare({ pubkey: candidate.pubkey, kind: 'select' });
      this.candidate = candidate;
      this.preparing = null;
      const pending = this.prepare({ pubkey: candidate.pubkey, kind: 'import' });
      candidate = null;
      return pending;
    } catch (error) {
      this.failedPreparation(previous, generation, error);
      throw error;
    } finally {
      if (candidate) this.ports.vault.cancelImport(candidate);
      if (generation === this.preparationGeneration) this.preparing = null;
    }
  }
  prepareRemoteConnection(): Promise<IdentityChange | null> { return this.prepareRemoteChange('connect'); }
  prepareRemoteRefresh(): Promise<IdentityChange | null> { return this.prepareRemoteChange('refresh-remote'); }
  prepareAndroidSigner(): Promise<IdentityChange | null> { return this.prepareRemoteChange('connect-android'); }
  private async prepareRemoteChange(kind: 'connect' | 'refresh-remote' | 'connect-android'): Promise<IdentityChange | null> {
    this.requireReady();
    const previous = this.state.session;
    const generation = ++this.preparationGeneration;
    this.preparing = 'connect';
    let candidate: NativeRemoteCandidate | null = null;
    try {
      if (kind === 'connect-android') candidate = await this.ports.vault.prepareAndroidSigner();
      else if (kind === 'refresh-remote') candidate = await this.ports.vault.prepareRemoteRefresh(previous.vault.selectedPubkey);
      else candidate = await this.ports.vault.prepareRemoteConnection();
      if (!candidate) return null;
      if (generation !== this.preparationGeneration || this.state.phase !== 'ready') return null;
      this.remoteCandidate = candidate;
      this.preparing = null;
      const pending = this.prepare({ pubkey: candidate.pubkey, kind });
      candidate = null;
      return pending;
    } catch (error) {
      this.failedPreparation(previous, generation, error);
      throw error;
    } finally {
      if (candidate) this.cancelRemoteCandidate(candidate, kind);
      if (generation === this.preparationGeneration) this.preparing = null;
    }
  }
  private cancelRemoteCandidate(candidate: NativeRemoteCandidate, kind: IdentityChange['kind']): void {
    if (kind === 'refresh-remote') this.ports.vault.cancelRemoteRefresh(candidate);
    else if (kind === 'connect-android') this.ports.vault.cancelAndroidSigner(candidate);
    else this.ports.vault.cancelRemoteConnection(candidate);
  }
  private failedPreparation(previous: IdentitySession, generation: number, error: unknown): void {
    if (this.state.session !== previous) return;
    // A cancelled operation may still close the shared vault cache. A healthy later operation stays untouched.
    if (generation === this.preparationGeneration || !this.sameVault(previous.vault)) this.failedChange(previous, error);
  }
  async getSigningMethods() {
    this.requireReady();
    const before = this.state.session;
    try {
      const methods = await this.ports.vault.getSigningMethods(before.vault.selectedPubkey);
      if (this.state.session !== before || this.state.phase !== 'ready') throw new IdentityChangeError('STALE');
      return methods;
    } catch (error) {
      if (this.state.session === before && this.state.phase === 'ready') this.failedChange(before, error);
      throw error;
    }
  }
  prepareSigningMethod(method: SigningMethodKind): IdentityChange {
    this.requireReady();
    if (method !== 'local' && method !== 'nip46' && method !== 'nip55') throw new VaultError('SIGNER_UNSUPPORTED');
    return this.prepare({ pubkey: this.state.session.vault.selectedPubkey, kind: 'select-method', method })!;
  }
  prepareDisconnect(method: 'nip46' | 'nip55' = 'nip46'): IdentityChange {
    this.requireReady();
    if (method !== 'nip46' && method !== 'nip55') throw new VaultError('SIGNER_UNSUPPORTED');
    return this.prepare({ pubkey: this.state.session.vault.selectedPubkey, kind: 'disconnect-method', method })!;
  }
  prepareDeleteLocalKey(): IdentityChange {
    this.requireReady();
    return this.prepare({ pubkey: this.state.session.vault.selectedPubkey, kind: 'delete-local-key' })!;
  }
  private cancelPreparation(kind: 'import' | 'connect'): void {
    if (this.preparing !== kind) return;
    this.preparationGeneration += 1;
    this.preparing = null;
    if (kind === 'import') this.ports.vault.cancelImportPreparation?.();
    else this.ports.vault.cancelRemotePreparation();
  }
  cancelImportPreparation(): void { this.cancelPreparation('import'); }
  cancelRemotePreparation(): void { this.cancelPreparation('connect'); }
  backgroundRemotePreparation(): void {
    if (this.preparing !== 'connect') return;
    try { if (this.ports.vault.isRemotePreparationHandoffPending()) return; } catch { /* Query failure cannot retain an attempt. */ }
    this.cancelRemotePreparation();
  }
  cancel(pending: IdentityChange): void {
    if (this.state.phase !== 'confirming' || this.state.pending !== pending) return;
    if (this.candidate) this.ports.vault.cancelImport(this.candidate);
    if (this.remoteCandidate) this.cancelRemoteCandidate(this.remoteCandidate, pending.kind);
    this.candidate = null;
    this.remoteCandidate = null;
    this.publish('ready');
  }
  private commit(pending: IdentityChange, candidate: NativeImportCandidate | null, remote: NativeRemoteCandidate | null): Promise<VaultSnapshot> {
    switch (pending.kind) {
      case 'import':
        if (!candidate) throw new IdentityChangeError('STALE');
        return this.ports.vault.commitImport(candidate);
      case 'connect':
        if (!remote) throw new IdentityChangeError('STALE');
        return this.ports.vault.commitRemoteConnection(remote);
      case 'connect-android':
        if (!remote) throw new IdentityChangeError('STALE');
        return this.ports.vault.commitAndroidSigner(remote);
      case 'refresh-remote':
        if (!remote) throw new IdentityChangeError('STALE');
        return this.ports.vault.commitRemoteRefresh(remote);
      case 'select': return this.ports.vault.select(pending.pubkey);
      case 'select-method': return this.ports.vault.selectSigningMethod(pending.pubkey, pending.method);
      case 'disconnect-method': return this.ports.vault.disconnectSigningMethod(pending.pubkey, pending.method);
      case 'delete-local-key': return this.ports.vault.deleteLocalKey(pending.pubkey);
    }
  }
  cancelChange(): void {
    if (!this.activeChange) return;
    this.activeChange.cancelled = true;
    try { this.ports.vault.cancelAction(); } catch { /* Local cancellation remains effective if native cleanup fails. */ }
  }
  /** Call from the trusted confirmation button with its exact current snapshot. */
  async confirm(pending: IdentityChange): Promise<void> {
    if (this.state.phase !== 'confirming' || this.state.pending !== pending) throw new IdentityChangeError('STALE');
    const previous = this.state.session;
    const operation = { session: previous, cancelled: false };
    this.activeChange = operation;
    const candidate = this.candidate, remote = this.remoteCandidate;
    this.candidate = null;
    this.remoteCandidate = null;
    previous.workspace.freeze();
    this.publish('switching');
    let workspace: WorkspaceController | null = null;
    try {
      await previous.workspace.flush();
      if (previous.workspace.getSnapshot().error !== null) throw new IdentityChangeError('RECOVERY_REQUIRED');
      if (operation.cancelled) throw new VaultError('AUTHORIZATION_DENIED');
      const carried = previous.workspace.getSnapshot().workspace;
      const vault = await this.commit(pending, candidate, remote);
      if (operation.cancelled) throw new VaultError(vault.revision === previous.vault.revision ? 'AUTHORIZATION_DENIED' : 'READBACK_FAILED');
      if (vault.selectedPubkey !== pending.pubkey) throw new IdentityChangeError('RECOVERY_REQUIRED');
      previous.workspace.revoke();
      const epoch = previous.epoch + 1;
      workspace = await this.openWorkspace(vault, epoch, () => carried);
      if (operation.cancelled) throw new VaultError('READBACK_FAILED');
      workspace.change(carried);
      await workspace.flush();
      if (operation.cancelled) throw new VaultError('READBACK_FAILED');
      if (workspace.getSnapshot().error !== null) throw new IdentityChangeError('RECOVERY_REQUIRED');
      this.publish('ready', Object.freeze({ vault, workspace, epoch }));
    } catch (error) {
      workspace?.revoke();
      this.failedChange(previous, error);
      throw error instanceof VaultError ? error : new IdentityChangeError('RECOVERY_REQUIRED');
    } finally {
      if (this.activeChange === operation) this.activeChange = null;
      if (candidate) this.ports.vault.cancelImport(candidate);
      if (remote) this.cancelRemoteCandidate(remote, pending.kind);
    }
  }
  cancelDeletion(session: IdentitySession): void {
    if (this.state.phase === 'deleting' && this.activeDeletion?.session === session) this.activeDeletion.cancelled = true;
  }
  /** Call only from the trusted deletion confirmation with its exact captured session. */
  async deleteInactive(pubkey: string, expected: IdentitySession): Promise<void> {
    this.requireReady();
    if (this.state.session !== expected) throw new IdentityChangeError('STALE');
    const base = expected.vault;
    if (!base.identities.some(identity => identity.pubkey === pubkey)) throw new VaultError('NOT_FOUND');
    if (pubkey === base.selectedPubkey || base.identities.length < 2) throw new VaultError('DELETE_SELECTED');
    if (base.pendingDeletion !== null && base.pendingDeletion !== pubkey) throw new VaultError('PENDING_DELETION');
    if (!this.ports.vault.deleteIdentity) throw new VaultError('AUTHORIZATION_DENIED');
    const operation = { session: expected, cancelled: false };
    const assertActive = () => { if (operation.cancelled) throw new VaultError('AUTHORIZATION_DENIED'); };
    this.activeDeletion = operation;
    expected.workspace.freeze();
    this.publish('deleting');
    try {
      await expected.workspace.flush();
      if (expected.workspace.getSnapshot().error !== null || JSON.stringify(this.ports.vault.getSnapshot()) !== JSON.stringify(base)) {
        throw new IdentityChangeError('RECOVERY_REQUIRED');
      }
      assertActive();
      const vault = await this.ports.vault.deleteIdentity(pubkey, assertActive);
      if (!isExpectedDeletion(base, vault, pubkey, true) || JSON.stringify(vault) !== JSON.stringify(this.ports.vault.getSnapshot())) {
        throw new IdentityChangeError('RECOVERY_REQUIRED');
      }
      this.publish('ready', Object.freeze({ ...expected, vault }));
      expected.workspace.resume();
    } catch (error) {
      this.failedDeletion(expected, pubkey, error);
      throw error instanceof VaultError ? error : new IdentityChangeError('RECOVERY_REQUIRED');
    } finally { if (this.activeDeletion === operation) this.activeDeletion = null; }
  }
  private failedDeletion(previous: IdentitySession, target: string, error: unknown): void {
    if (error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED' && previous.workspace.getSnapshot().error === null) {
      try {
        const vault = this.ports.vault.getSnapshot();
        if (isExpectedDeletion(previous.vault, vault, target, false)) {
          const session = JSON.stringify(vault) === JSON.stringify(previous.vault) ? previous : Object.freeze({ ...previous, vault });
          this.publish('ready', session, null, vault.pendingDeletion === null ? 'DELETION_REJECTED' : 'DELETION_PENDING');
          previous.workspace.resume();
          return;
        }
      } catch { /* Unknown deletion outcomes require reopening the durable journal. */ }
    }
    previous.workspace.revoke();
    this.publish('recovery');
  }
  private sameVault(expected: VaultSnapshot): boolean {
    try {
      const current = this.ports.vault.getSnapshot();
      return current.vaultId === expected.vaultId && current.selectedPubkey === expected.selectedPubkey && current.revision === expected.revision;
    } catch { return false; }
  }
  private failedChange(previous: IdentitySession, error: unknown): void {
    if (this.sameVault(previous.vault) && previous.workspace.getSnapshot().error === null && error instanceof VaultError &&
        ['INVALID_NSEC', 'NOT_FOUND', 'LIMIT_REACHED', 'PENDING_DELETION', 'AUTHORIZATION_DENIED', ...SIGNER_FAILURE_CODES].includes(error.code)) {
      previous.workspace.resume();
      this.publish('ready', previous, null, error.code === 'LIMIT_REACHED' ? 'LIMIT_REACHED' : isSignerFailureCode(error.code) ? error.code : 'CHANGE_REJECTED');
    } else {
      previous.workspace.revoke();
      this.publish('recovery');
    }
  }
  /** Capture once when registering native capabilities; never accept a caller's identity. */
  sessionAuthority(): { readonly user: string; readonly epoch: number; assertActive(): void } {
    const session = this.state.session;
    return Object.freeze({ user: session.vault.selectedPubkey, epoch: session.epoch, assertActive: () => {
      const current = this.state;
      if ((current.phase !== 'ready' && current.phase !== 'confirming') || current.session.workspace !== session.workspace || current.session.epoch !== session.epoch) throw new IdentityChangeError('STALE');
      const actual = this.ports.vault.getSnapshot();
      if (actual.vaultId !== session.vault.vaultId || actual.selectedPubkey !== session.vault.selectedPubkey || actual.revision !== current.session.vault.revision) throw new IdentityChangeError('STALE');
    } });
  }
}
