import { SigningForeground, signingHandoffState, type SigningHandoffReader } from '../security/signing-handoff.ts';
import type { NativeSigningSource } from '../security/native-vault-contract.ts';
import { VaultError } from '../security/identity-vault-model.ts';
import { isSignerFailureCode, type SignerFailureCode } from '../security/signing-methods.ts';
import { UploadRecoveryService, type UploadRecoveryPort } from './upload-recovery.ts';
import type { ApprovalOrigin, EffectAuthority, TrustedApprovalOwner } from '../security/approval-service.ts';
import { publicKey, text } from '../storage/codec.ts';
import { captureUploadAuthorization } from './upload-authorization.ts';
import { captureUploadSnapshot, type UploadSnapshot } from './upload-snapshot.ts';
import { captureBlobDescriptor, matchesUploadMime, normalizeUploadServer, parseUploadRequest, uploadHash, uploadMime, UploadError, UPLOAD_LIMITS,
  type UploadErrorCode, type UploadResult, type UploadPayload } from './upload-contract.ts';

export type UploadReview = Readonly<{ purpose: 'blossom-upload'; identity: string; destination: string; sha256: string;
  size: number; mimeType: string; metadataPolicy: 'photo-stripped' | 'attachment-unchanged' }>;
export type { UploadResult } from './upload-contract.ts';
export type UploadLease = object;
export type TakenUpload = Readonly<{lease: UploadLease; origin: ApprovalOrigin; uploadId: string;
  filename: string; caption: string; request: Readonly<Omit<UploadPayload, 'data'>>; review: UploadReview}>;
/** App-only operations. Implementations retain the native review/grant and original guest recipient. */
export interface UploadNativePort {
  readonly recovery?: UploadRecoveryPort;
  take(token: string): TakenUpload | null;
  observeProgress?(lease: UploadLease, update: (sent: number, total: number) => void): () => void;
  signingSource?(lease: UploadLease): NativeSigningSource;
  isLive(lease: UploadLease): boolean;
  mayReview(lease: UploadLease): boolean;
  readPreview(lease: UploadLease, offset: number): Uint8Array<ArrayBuffer>;
  approveOnce(lease: UploadLease): boolean;
  isApproved(lease: UploadLease): boolean;
  claimSigning(lease: UploadLease): boolean;
  put(lease: UploadLease, credential: string): Promise<unknown>;
  wasDispatched(lease: UploadLease): boolean;
  cancel(lease: UploadLease): void;
  finish(lease: UploadLease, result: UploadResult): void;
}
export interface UploadEffects extends SigningHandoffReader {
  currentIdentity?(): string | null;
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
  sign(snapshot: UploadSnapshot, authority: EffectAuthority): Promise<unknown>;
  nowSeconds(): number;
}
export type UploadItem = Readonly<{id: string; origin: ApprovalOrigin; uploadId: string; filename: string;
  caption: string; request: Readonly<Omit<UploadPayload, 'data'>>; review: UploadReview; previewReady: boolean; copyPreview(): Uint8Array<ArrayBuffer> | null}>;
export type UploadPresentation = Readonly<{current: UploadItem | null; pending: number;
  pendingSessionIds: readonly string[]; active: readonly Readonly<{id: string; origin: ApprovalOrigin; review: UploadReview; phase: 'authorizing' | 'transferring'; bytesSent: number; bytesTotal: number}>[];
  outcomes: readonly Readonly<{id: string; origin: ApprovalOrigin; review: UploadReview; result: UploadResult; signingFailure: SignerFailureCode | null}>[]}>;
type Entry = TakenUpload & {id: string; body: Uint8Array<ArrayBuffer> | null; preparing: boolean; signingPending: boolean; signingFailure: SignerFailureCode | null; phase: 'authorizing' | 'transferring'; controller: AbortController | null; bytesSent: number; detachProgress: (() => void) | null};
let nextId = 0;
function denied(): never { throw new UploadError('policy denied'); }
function origin(value: ApprovalOrigin): ApprovalOrigin {
  return Object.freeze({sessionId: text(value.sessionId, 80), generation: text(value.generation, 80), epoch: value.epoch,
    user: publicKey(value.user), publisher: publicKey(value.publisher), appId: text(value.appId, 1024),
    version: publicKey(value.version), instanceId: text(value.instanceId, 80)});
}
function review(value: UploadReview, identity: string): UploadReview {
  if (value.purpose !== 'blossom-upload' || value.identity !== identity || !Number.isSafeInteger(value.size) ||
    value.size < 0 || value.size > UPLOAD_LIMITS.fileBytes || !['photo-stripped', 'attachment-unchanged'].includes(value.metadataPolicy)) denied();
  const mimeType = uploadMime(value.mimeType);
  if (mimeType.startsWith('image/') && value.metadataPolicy !== 'photo-stripped') denied();
  return Object.freeze({purpose: 'blossom-upload', identity, destination: normalizeUploadServer(value.destination),
    sha256: uploadHash(value.sha256), size: value.size, mimeType, metadataPolicy: value.metadataPolicy});
}

/** Trusted presentation and protected signing. Native code owns body, review, transport and irreversible revocation. */
export class UploadService {
  readonly recovery: UploadRecoveryService | null;
  private entries: Entry[] = [];
  private focused: string | null = null;
  private readonly foregroundState = new SigningForeground();
  private listeners = new Set<() => void>();
  private readonly closeRisks = new Map<string, number>();
  private outcomes: UploadPresentation['outcomes'] = Object.freeze([]);
  private snapshot: UploadPresentation = Object.freeze({current: null, pending: 0, pendingSessionIds: Object.freeze([]),
    active: Object.freeze([]), outcomes: this.outcomes});
  private readonly native: UploadNativePort;
  private readonly owner: TrustedApprovalOwner;
  private readonly effects: UploadEffects;
  constructor(native: UploadNativePort, owner: TrustedApprovalOwner, effects: UploadEffects) {
    this.native = native; this.owner = owner; this.effects = effects;
    this.recovery = native.recovery && effects.currentIdentity ? new UploadRecoveryService(native.recovery, effects.currentIdentity) : null;
  }
  hasCloseRisk(sessionId: string): boolean {
    return this.closeRisks.has(sessionId) || this.entries.some(entry => entry.origin.sessionId === sessionId);
  }
  getSnapshot = (): UploadPresentation => this.snapshot;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(): void {
    let shown: Entry | undefined;
    if (this.foregroundState.active && this.focused !== null && this.entries.filter(entry => entry.controller !== null).length < UPLOAD_LIMITS.processConcurrent) shown = this.entries.find(entry => entry.origin.sessionId === this.focused &&
      entry.controller === null && this.safe(() => this.native.mayReview(entry.lease)));
    const previous = this.snapshot.current;
    const current = shown ? previous?.id === shown.id && previous.previewReady === (shown.body !== null) ? previous : Object.freeze({id: shown.id, origin: shown.origin, uploadId: shown.uploadId,
      filename: shown.filename, caption: shown.caption, request: shown.request, review: shown.review, previewReady: shown.body !== null,
      copyPreview: () => this.entries.includes(shown!) && this.safe(() => this.native.mayReview(shown!.lease)) && shown!.body ?
        new Uint8Array(shown!.body) : null}) : null;
    const next: UploadPresentation = Object.freeze({current, pending: this.entries.filter(entry => entry.controller === null).length,
      pendingSessionIds: Object.freeze([...new Set(this.entries.filter(entry => entry.controller === null).map(entry => entry.origin.sessionId))]),
      active: Object.freeze(this.entries.filter(entry => entry.controller !== null).map(entry => Object.freeze({id: entry.id, origin: entry.origin, review: entry.review, phase: entry.phase, bytesSent: entry.bytesSent, bytesTotal: entry.review.size}))),
      outcomes: this.outcomes});
    const previousSnapshot = this.snapshot;
    if (next.current === previousSnapshot.current && next.pending === previousSnapshot.pending && next.outcomes === previousSnapshot.outcomes &&
      next.pendingSessionIds.length === previousSnapshot.pendingSessionIds.length && next.pendingSessionIds.every((id, index) => id === previousSnapshot.pendingSessionIds[index]) &&
      next.active.length === previousSnapshot.active.length && next.active.every((item, index) => {
        const before = previousSnapshot.active[index];
        return before?.id === item.id && before.origin === item.origin && before.review === item.review && before.phase === item.phase && before.bytesSent === item.bytesSent && before.bytesTotal === item.bytesTotal;
      })) return;
    this.snapshot = next;
    for (const listener of this.listeners) try { listener(); } catch { /* Observers have no authority. */ }
  }
  private safe(check: () => boolean): boolean { try { return check(); } catch { return false; } }
  private handoffState(entry: Entry) {
    try { return signingHandoffState(this.effects, this.native.signingSource?.(entry.lease)); } catch { return null; }
  }
  private handoffPending(entry: Entry): boolean {
    return entry.signingPending && this.handoffState(entry) === 'pending' && this.safe(() => !this.native.wasDispatched(entry.lease));
  }
  private awaitForeground(entry: Entry): Promise<void> {
    if (!this.foregroundState.active && this.handoffState(entry) !== 'resumed') denied();
    return this.foregroundState.wait(entry.controller!.signal);
  }
  private active(entry: Entry, approved: boolean): void {
    if (!this.foregroundState.active || !this.entries.includes(entry) || entry.controller?.signal.aborted ||
      !this.native.isLive(entry.lease) || (approved && !this.native.isApproved(entry.lease))) denied();
    this.owner.assertActive(entry.origin);
  }
  enqueue(token: string, expected: ApprovalOrigin): boolean {
    this.refresh();
    let taken: TakenUpload | null;
    try { taken = this.native.take(token); } catch { return false; }
    if (!taken) return false;
    try {
      const captured = origin(taken.origin), anticipated = origin(expected);
      if (Object.keys(captured).some(key => captured[key as keyof ApprovalOrigin] !== anticipated[key as keyof ApprovalOrigin]) ||
        this.entries.length >= UPLOAD_LIMITS.pendingReviews + UPLOAD_LIMITS.processConcurrent || this.entries.filter(entry => entry.controller === null).length >= UPLOAD_LIMITS.pendingReviews || this.entries.some(entry => entry.origin.generation === captured.generation) ||
        !Number.isSafeInteger(captured.epoch) || captured.epoch < 0 || nextId >= Number.MAX_SAFE_INTEGER) denied();
      this.owner.assertActive(captured);
      const item = review(taken.review, captured.user);
      const checked = parseUploadRequest({type: 'upload.upload', id: 'native-header', request: {...taken.request, data: new ArrayBuffer(0)}});
      if (checked.type !== 'upload.upload') denied();
      const {data: _data, ...header} = checked.request;
      const entry: Entry = {lease: taken.lease, origin: captured, uploadId: text(taken.uploadId, UPLOAD_LIMITS.idBytes),
        filename: text(taken.filename, UPLOAD_LIMITS.filenameBytes, true), caption: text(taken.caption, UPLOAD_LIMITS.captionBytes, true),
        request: Object.freeze(header), review: item, id: 'upload-review-' + ++nextId, body: null, preparing: false, signingPending: false, signingFailure: null, phase: 'authorizing', controller: null, bytesSent: 0, detachProgress: null};
      entry.detachProgress = this.native.observeProgress?.(entry.lease, (sent, total) => {
        if (!this.entries.includes(entry) || entry.controller === null || !this.safe(() => this.native.isApproved(entry.lease)) ||
          !Number.isSafeInteger(sent) || sent < entry.bytesSent || total !== entry.review.size || sent > total) return;
        entry.bytesSent = sent; this.publish();
      }) ?? null;
      this.entries.push(entry);
      this.publish(); void this.prepareCurrent(); return true;
    } catch {
      try { this.native.cancel(taken.lease); } catch { /* Finish still owns terminal cleanup. */ }
      try { this.native.finish(taken.lease, Object.freeze({ok: false, uploadId: taken.uploadId, status: 'failed', rail: 'blossom', error: 'policy denied'})); } catch { /* Native denial is terminal. */ }
      return false;
    }
  }
  private async prepareCurrent(): Promise<void> {
    const entry = this.entries.find(value => value.id === this.snapshot.current?.id);
    if (!entry || entry.body || entry.preparing || entry.controller) return;
    entry.preparing = true;
    const body = new Uint8Array(entry.review.size);
    try {
      for (let offset = 0; offset < body.length;) {
        this.active(entry, false);
        if (!this.native.mayReview(entry.lease)) denied();
        const chunk = this.native.readPreview(entry.lease, offset);
        if (!(chunk instanceof Uint8Array) || chunk.length !== Math.min(UPLOAD_LIMITS.chunkBytes, body.length - offset)) denied();
        body.set(chunk, offset); offset += chunk.length; chunk.fill(0);
      }
      const hash = await this.effects.sha256(new Uint8Array(body));
      this.active(entry, false);
      if (uploadHash(hash) !== entry.review.sha256) denied();
      entry.body = body;
    } catch { body.fill(0); this.end(entry, 'policy denied'); }
    finally { entry.preparing = false; this.publish(); }
  }
  refresh(): void {
    for (const entry of this.entries) {
      try {
        const awaitingForeground = entry.signingPending && !this.foregroundState.active && this.handoffState(entry) === 'resumed' && this.safe(() => !this.native.wasDispatched(entry.lease));
        if (!this.handoffPending(entry) && !awaitingForeground) this.active(entry, entry.controller !== null);
      }
      catch { this.end(entry, 'user cancelled'); }
    }
    this.publish(); void this.prepareCurrent();
  }
  focus(sessionId: string | null): void { this.focused = sessionId; this.publish(); void this.prepareCurrent(); }
  foreground(): void { this.recovery?.foreground(); this.foregroundState.setActive(true); this.refresh(); }
  background(): void { this.recovery?.background(); this.foregroundState.setActive(false); for (const entry of this.entries) if (!this.handoffPending(entry)) this.end(entry, 'user cancelled'); this.publish(); }
  close(sessionId: string): void {
    for (const entry of this.entries) if (entry.origin.sessionId === sessionId) this.end(entry, 'user cancelled');
    this.closeRisks.delete(sessionId);
    this.outcomes = Object.freeze(this.outcomes.filter(item => item.origin.sessionId !== sessionId)); this.publish();
  }
  revisionChanged(epoch: number): void {
    this.recovery?.invalidate();
    for (const entry of this.entries) if (entry.origin.epoch !== epoch) this.end(entry, 'user cancelled');
    for (const [id, value] of this.closeRisks) if (value !== epoch) this.closeRisks.delete(id);
    this.outcomes = Object.freeze(this.outcomes.filter(item => item.origin.epoch === epoch)); this.publish();
  }
  reject(id: string): void { if (this.snapshot.current?.id === id) this.cancel(id); }
  cancel(id: string): void {
    const entry = this.entries.find(value => value.id === id);
    if (entry) this.end(entry, 'user cancelled'); this.publish(); void this.prepareCurrent();
  }
  dismissOutcome(id: string): void { this.outcomes = Object.freeze(this.outcomes.filter(item => item.id !== id)); this.publish(); }
  private end(entry: Entry, error: UploadErrorCode | null, success?: UploadResult): UploadResult {
    if (!this.entries.includes(entry)) return Object.freeze({ok: false, uploadId: entry.uploadId, status: 'cancelled', rail: 'blossom', error: 'user cancelled'});
    let dispatched = true;
    try { dispatched = this.native.wasDispatched(entry.lease) !== false; } catch { /* Loss of dispatch evidence must remain uncertain. */ }
    const code = error === 'user cancelled' && dispatched ? 'outcome unknown' : error;
    const result: UploadResult = success ?? Object.freeze({ok: false, uploadId: entry.uploadId,
      status: code === 'user cancelled' ? 'cancelled' : 'failed', rail: 'blossom', error: code ?? 'upload failed'});
    if (result.error === 'outcome unknown') this.closeRisks.set(entry.origin.sessionId, entry.origin.epoch);
    try { this.native.finish(entry.lease, result); }
    catch { try {this.native.cancel(entry.lease);} catch { /* Native loss still requires app cleanup. */ } }
    try {entry.detachProgress?.();} catch { /* Progress observers cannot prevent native cleanup. */ }
    entry.detachProgress = null;
    entry.controller?.abort(); entry.body?.fill(0); entry.body = null;
    this.entries = this.entries.filter(value => value !== entry);
    const signingFailure = entry.signingFailure ?? (entry.signingPending ? 'SIGNER_UNCERTAIN' : null);
    this.outcomes = Object.freeze([...this.outcomes, Object.freeze({id: entry.id, origin: entry.origin, review: entry.review, result, signingFailure})].slice(-UPLOAD_LIMITS.retainedStatuses));
    return result;
  }
  async approve(id: string): Promise<UploadResult> {
    this.refresh();
    const entry = this.entries.find(value => value.id === id);
    if (!entry || this.snapshot.current?.id !== id || !entry.body || entry.controller) denied();
    try {
      this.active(entry, false);
      if (!this.native.mayReview(entry.lease) || !this.native.approveOnce(entry.lease)) denied();
      entry.controller = new AbortController(); this.publish();
      const execution: EffectAuthority = Object.freeze({nativeSource: this.native.signingSource?.(entry.lease), signal: entry.controller.signal, awaitForeground: () => this.awaitForeground(entry), assertActive: () => this.active(entry, true)});
      const now = this.effects.nowSeconds();
      if (!Number.isSafeInteger(now) || now < 2) denied();
      const snapshot = await captureUploadSnapshot(entry.body, entry.origin.user, entry.review.destination, entry.review.mimeType,
        now - 1, this.effects.sha256);
      execution.assertActive();
      if (snapshot.sha256 !== entry.review.sha256 || snapshot.size !== entry.review.size || !this.native.claimSigning(entry.lease)) denied();
      entry.signingPending = true;
      const signed = await this.effects.sign(snapshot, execution);
      await execution.awaitForeground?.(); entry.signingPending = false;
      execution.assertActive();
      const credential = captureUploadAuthorization(snapshot, signed, this.effects.nowSeconds());
      entry.phase = 'transferring'; this.publish();
      execution.assertActive();
      const response = await this.native.put(entry.lease, credential.token);
      execution.assertActive();
      const descriptor = captureBlobDescriptor(response, entry.review.sha256, entry.review.size);
      if (!matchesUploadMime(descriptor.type, entry.review.mimeType, entry.body)) throw new UploadError('upload failed');
      return this.end(entry, null, Object.freeze({ok: true, uploadId: entry.uploadId, status: 'complete', rail: 'blossom',
        url: descriptor.url, sha256: descriptor.sha256, size: descriptor.size, mimeType: entry.review.mimeType}));
    } catch (error) {
      const authorizationDenied = entry.signingPending && error instanceof VaultError && error.code === 'AUTHORIZATION_DENIED';
      if (entry.signingPending && error instanceof VaultError && isSignerFailureCode(error.code)) entry.signingFailure = error.code;
      entry.signingPending = false;
      if (!this.entries.includes(entry)) return this.outcomes.find(value => value.id === entry.id)?.result ??
        Object.freeze({ok: false, uploadId: entry.uploadId, status: 'cancelled', rail: 'blossom', error: 'user cancelled'});
      let dispatched = true;
      try { dispatched = this.native.wasDispatched(entry.lease) !== false; } catch { /* Lost native evidence cannot prove no dispatch. */ }
      const definitive = error instanceof UploadError && ['server rejected', 'file too large', 'quota exceeded'].includes(error.code);
      return this.end(entry, dispatched && !definitive ? 'outcome unknown' : authorizationDenied && !dispatched ? 'user cancelled' : error instanceof UploadError ? error.code : 'upload failed');
    } finally { this.publish(); void this.prepareCurrent(); }
  }
}
