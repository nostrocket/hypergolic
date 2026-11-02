import { VaultError, type DeletionGrant, type VaultDependencies } from './identity-vault.ts';
import type { NativeDeletionTokens } from './ios-encrypted-secrets.ts';

/** Exact trusted-shell Expo contract. No caller-selected runtime, epoch, service or path. */
export interface IdentityActionsModule {
  activateIdentityActions(): void;
  isDeletionAvailableAsync(): Promise<boolean>;
  /** Optional until both native hosts expose the trusted backup panel. */
  isBackupAvailableAsync?(): Promise<boolean>;
  beginSettingsAsync(selectedPubkey: string, revision: number): Promise<string>;
  endSettings(session: string): void;
  cancelDeletion(session: string): void;
  showBackupAsync?(session: string, targetPubkey: string, selectedPubkey: string, revision: number): Promise<void>;
  cancelBackup?(session: string): void;
  authorizeDeletionAsync(session: string, targetPubkey: string, selectedPubkey: string, revision: number): Promise<string>;
  assertDeletionGrantActive(session: string, targetPubkey: string, token: string): void;
}
type Context = Readonly<{ selectedPubkey: string; revision: number }>;
export type BackupRequest = Readonly<{ pubkey: string; selectedPubkey: string; revision: number }>;
type GrantRecord = { session: string; target: string; token: string; epoch: number };
const pubkey = /^[0-9a-f]{64}$/;
const opaque = /^[A-Za-z0-9_-]{16,128}$/;
function validContext(value: Context): boolean {
  return typeof value.selectedPubkey === 'string' && pubkey.test(value.selectedPubkey)
    && Number.isSafeInteger(value.revision) && value.revision > 0;
}
function denied(): never { throw new VaultError('AUTHORIZATION_DENIED'); }

class IdentityActionsOwner {
  private readonly module: IdentityActionsModule;
  private readonly grants = new WeakMap<DeletionGrant, GrantRecord>();
  private current: (Context & { session: string }) | null = null;
  private epoch = 0;
  private closed = false;
  private opening = false;
  private pending = false;
  private backupSession: string | null = null;
  readonly tokens: NativeDeletionTokens;
  constructor(module: IdentityActionsModule) {
    this.module = module;
    this.tokens = Object.freeze({ consume: (grant: DeletionGrant, target: string) => this.consume(grant, target) });
  }
  private invalidate() {
    if (this.epoch === Number.MAX_SAFE_INTEGER) { this.closed = true; denied(); }
    this.epoch += 1;
  }
  private validate(record: GrantRecord) {
    if (this.closed || record.epoch !== this.epoch || this.current?.session !== record.session) denied();
    try { this.module.assertDeletionGrantActive(record.session, record.target, record.token); } catch { denied(); }
  }
  private consume(grant: DeletionGrant, target: string): string {
    const record = this.grants.get(grant);
    if (!record || record.target !== target) denied();
    this.validate(record); this.grants.delete(grant);
    return record.token;
  }
  private validRequest(request: BackupRequest, selectedOnly: boolean) {
    return !this.closed && !this.opening && !this.pending && this.current !== null && validContext(request)
      && pubkey.test(request.pubkey) && (selectedOnly ? request.pubkey === this.current.selectedPubkey : request.pubkey !== this.current.selectedPubkey)
      && request.selectedPubkey === this.current.selectedPubkey && request.revision === this.current.revision;
  }
  endSettings() {
    const previous = this.current; this.current = null; this.invalidate();
    if (previous) try { this.module.endSettings(previous.session); } catch { denied(); }
  }
  async beginSettings(context: Context): Promise<void> {
    if (this.closed || this.opening || this.pending || !validContext(context)) denied();
    this.endSettings(); const captured = Object.freeze({ ...context }); const requestEpoch = this.epoch;
    this.opening = true;
    try {
      const session = await this.module.beginSettingsAsync(captured.selectedPubkey, captured.revision);
      if (typeof session !== 'string' || !opaque.test(session)) denied();
      if (this.closed || requestEpoch !== this.epoch) { try { this.module.endSettings(session); } catch { denied(); } denied(); }
      this.current = { ...captured, session };
    } catch { denied(); } finally { this.opening = false; }
  }
  cancelDeletion() {
    const session = this.current?.session; this.invalidate();
    if (session) try { this.module.cancelDeletion(session); } catch { denied(); }
  }
  async showBackup(request: BackupRequest): Promise<void> {
    if (!this.validRequest(request, true) || !this.hasBackupMethods()) denied();
    const session = this.current!.session, requestEpoch = this.epoch;
    this.pending = true; this.backupSession = session;
    try {
      await this.module.showBackupAsync!(session, request.pubkey, this.current!.selectedPubkey, this.current!.revision);
      if (this.closed || requestEpoch !== this.epoch || this.current?.session !== session) denied();
    } catch { denied(); } finally { if (this.backupSession === session) this.backupSession = null; this.pending = false; }
  }
  cancelBackup() {
    const session = this.backupSession; this.invalidate(); this.backupSession = null;
    if (session) try { this.module.cancelBackup!(session); } catch { denied(); }
  }
  async authorizeDeletion(request: Parameters<VaultDependencies['authorizeDeletion']>[0]): Promise<DeletionGrant> {
    if (!this.validRequest(request, false)) denied();
    const session = this.current!.session, target = request.pubkey, requestEpoch = this.epoch;
    this.pending = true;
    try {
      const token = await this.module.authorizeDeletionAsync(session, target, this.current!.selectedPubkey, this.current!.revision);
      if (typeof token !== 'string' || !opaque.test(token) || requestEpoch !== this.epoch || this.current?.session !== session || this.closed) denied();
      const record = { session, target, token, epoch: requestEpoch }; this.validate(record);
      const grant: DeletionGrant = Object.freeze({ assertActive: () => { const owned = this.grants.get(grant); if (!owned) denied(); this.validate(owned); } });
      this.grants.set(grant, record); return grant;
    } catch { denied(); } finally { this.pending = false; }
  }
  async isDeletionAvailable(): Promise<boolean> {
    if (this.closed) return false;
    try { return await this.module.isDeletionAvailableAsync() === true && !this.closed; } catch { return false; }
  }
  private hasBackupMethods(): boolean {
    return typeof this.module.isBackupAvailableAsync === 'function' && typeof this.module.showBackupAsync === 'function' && typeof this.module.cancelBackup === 'function';
  }
  async isBackupAvailable(): Promise<boolean> {
    if (this.closed || !this.hasBackupMethods()) return false;
    try { return await this.module.isBackupAvailableAsync!() === true && !this.closed; } catch { return false; }
  }
  dispose() { try { this.endSettings(); } finally { this.closed = true; } }
}

/** Call only after the native one-shot process claim. Retain one instance with the trusted vault. */
export function createIdentityActions(module: IdentityActionsModule, platform: string) {
  if (platform !== 'ios' && platform !== 'android') throw new VaultError('STORAGE_FAILURE');
  try { module.activateIdentityActions(); } catch { throw new VaultError('STORAGE_FAILURE'); }
  const owner = new IdentityActionsOwner(module);
  return Object.freeze({ beginSettings: owner.beginSettings.bind(owner), endSettings: owner.endSettings.bind(owner),
    cancelDeletion: owner.cancelDeletion.bind(owner), authorizeDeletion: owner.authorizeDeletion.bind(owner),
    showBackup: owner.showBackup.bind(owner), cancelBackup: owner.cancelBackup.bind(owner), tokens: owner.tokens,
    dispose: owner.dispose.bind(owner), isDeletionAvailable: owner.isDeletionAvailable.bind(owner), isBackupAvailable: owner.isBackupAvailable.bind(owner) });
}

export type IdentityActions = ReturnType<typeof createIdentityActions>;
