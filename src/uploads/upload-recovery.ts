import { publicKey, text } from '../storage/codec.ts';
import { normalizeUploadServer, uploadHash, uploadMime, UPLOAD_LIMITS } from './upload-contract.ts';

export type RecoveryState = 'unknown' | 'present' | 'absent' | 'confirmed' | 'rejected' | 'not_sent';
export type UploadRecoveryRecord = Readonly<{uploadId: string; identity: string; publisher: string; appId: string;
  destination: string; sha256: string; mimeType: string; size: number; state: RecoveryState}>;
/** App-only metadata/check lane. It cannot submit bytes, credentials, destinations or retry grants. */
export interface UploadRecoveryPort { list(): unknown; check(uploadId: string): Promise<unknown> }
export type UploadRecoveryPresentation = Readonly<{available: boolean; records: readonly UploadRecoveryRecord[];
  checking: readonly string[]; feedback: Readonly<Record<string, RecoveryState>>}>;
const states: readonly RecoveryState[] = ['unknown', 'present', 'absent', 'confirmed', 'rejected', 'not_sent'];
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Invalid recovery metadata');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) throw Error('Invalid recovery metadata');
  return value as Record<string, unknown>;
}
function capture(value: unknown, identity: string): UploadRecoveryRecord {
  const row = object(value, ['uploadId','identity','publisher','appId','destination','sha256','mimeType','size','state']);
  const uploadId = text(row.uploadId, 36);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uploadId) || row.identity !== identity || !Number.isSafeInteger(row.size) ||
    (row.size as number) < 1 || (row.size as number) > UPLOAD_LIMITS.fileBytes || !states.includes(row.state as RecoveryState)) throw Error('Invalid recovery metadata');
  const destination = normalizeUploadServer(row.destination);
  if (row.destination !== destination) throw Error('Invalid recovery destination');
  return Object.freeze({uploadId, identity: publicKey(row.identity), publisher: publicKey(row.publisher), appId: text(row.appId, 1024),
    destination, sha256: uploadHash(row.sha256), mimeType: uploadMime(row.mimeType), size: row.size as number, state: row.state as RecoveryState});
}
const empty = (): UploadRecoveryPresentation => Object.freeze({available: false, records: Object.freeze([]), checking: Object.freeze([]), feedback: Object.freeze({})});
/** Trusted presentation only. Native code owns persistence, fixed-hash reads and irreversible revocation. */
export class UploadRecoveryService {
  private readonly port: UploadRecoveryPort;
  private readonly currentIdentity: () => string | null;
  private identity: string | null = null;
  private foregrounded = true;
  private revision = 0;
  private busy = new Set<string>();
  private feedback: Record<string, RecoveryState> = {};
  private snapshot: UploadRecoveryPresentation = empty();
  private listeners = new Set<() => void>();
  constructor(port: UploadRecoveryPort, currentIdentity: () => string | null) { this.port = port; this.currentIdentity = currentIdentity; }
  hasUnresolvedOutcome(publisher: string, appId: string): boolean {
    this.refresh();
    return !this.snapshot.available || this.snapshot.records.some(row => row.publisher === publisher && row.appId === appId && row.state === 'unknown');
  }
  getSnapshot = (): UploadRecoveryPresentation => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; };
  private publish(available: boolean, records: readonly UploadRecoveryRecord[]): void {
    const checking = [...this.busy], feedback = {...this.feedback};
    const next = Object.freeze({available, records: Object.freeze([...records]), checking: Object.freeze(checking), feedback: Object.freeze(feedback)});
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next; for (const listener of this.listeners) try {listener();} catch { /* Observers have no read or retry authority. */ }
  }
  private reset(): void { this.revision++; this.busy.clear(); this.feedback = {}; this.publish(false, []); }
  background(): void { this.foregrounded = false; this.reset(); }
  foreground(): void { this.foregrounded = true; this.refresh(); }
  invalidate(): void { this.identity = null; this.reset(); }
  refresh(): void {
    try {
      const identity = this.foregrounded ? this.currentIdentity() : null;
      if (identity !== this.identity) { this.reset(); this.identity = identity; }
      if (identity === null) {this.publish(false, []); return;}
      publicKey(identity);
      const response = object(this.port.list(), ['available','identity','records']);
      if (response.available !== true || response.identity !== identity || !Array.isArray(response.records) || response.records.length > 32 || this.currentIdentity() !== identity) {
        this.publish(false, []); return;
      }
      const records = response.records.map(row => capture(row, identity));
      if (new Set(records.map(row => row.uploadId)).size !== records.length) throw Error('Duplicate recovery record');
      this.publish(true, records);
    } catch { this.publish(false, []); }
  }
  async check(uploadId: string): Promise<void> {
    this.refresh();
    const row = this.snapshot.records.find(record => record.uploadId === uploadId && record.state === 'unknown');
    if (!this.snapshot.available || !row || this.busy.has(uploadId) || this.busy.size >= 2) return;
    const revision = this.revision, identity = this.identity;
    this.busy.add(uploadId); this.publish(true, this.snapshot.records);
    let state: RecoveryState = 'unknown';
    try {
      const result = object(await this.port.check(uploadId), ['uploadId','state']);
      if (result.uploadId !== uploadId || !['unknown','present','absent'].includes(result.state as string)) throw Error('Invalid recovery check');
      state = result.state as RecoveryState;
    } catch { /* The saved uncertainty survives a failed check. */ }
    if (revision !== this.revision || !this.foregrounded || this.currentIdentity() !== identity) return;
    this.busy.delete(uploadId); this.refresh();
    const retained = this.snapshot.records.find(record => record.uploadId === uploadId);
    this.feedback[uploadId] = state !== 'unknown' && retained?.state === state ? state : 'unknown';
    this.publish(this.snapshot.available, this.snapshot.records);
  }
}
