import { SigningForeground, signingHandoffState, type SigningHandoffReader } from './signing-handoff.ts';
import {OutboxApprovalPreparation,type OutboxPublicationPlanner} from '../outbox/approval-preparation.ts';
import type {OutboxPublishRequest} from '../outbox/publication-contract.ts';
import type {OutboxPublicationPlan} from '../outbox/publication-plan.ts';
import {captureOutboxPublicationReceipt,type OutboxPublicationReceipt} from '../outbox/publication-receipt.ts';
import { captureEventSnapshot, type EventSnapshot } from './event-snapshot.ts';
import { validateSignedEvent, type VerifiedSignedEvent } from './signed-event.ts';
import {captureRelayOutcomes} from './relay-outcomes.ts';
import type { NativeSigningSource } from './native-vault-contract.ts';
import type { RelayOutcome } from '../network/relay-service.ts';

export type ApprovalOrigin = Readonly<{ sessionId: string; generation: string; epoch: number; user: string; publisher: string; appId: string; version: string; instanceId: string }>;
export type NativeApprovalLease = object;
export type NativeTakenApproval = Readonly<{ lease: NativeApprovalLease; origin: ApprovalOrigin; requestId: string; event: unknown; outboxRequest?:OutboxPublishRequest }>;
export interface NativeApprovalLeasePort {
  take(token: string): NativeTakenApproval | null;
  prepareOutbox?(lease:NativeApprovalLease,plan:OutboxPublicationPlan):boolean;
  failOutbox?(lease:NativeApprovalLease,error:string):void;
  publishOutbox?(lease:NativeApprovalLease,group:'primary'|'relay-list',event:VerifiedSignedEvent,destinations:readonly string[],execution:EffectAuthority):Promise<readonly RelayOutcome[]>;
  prepareSigning?(lease: NativeApprovalLease, snapshot: EventSnapshot): boolean;
  signingSource?(lease: NativeApprovalLease): NativeSigningSource;
  isLive(lease: NativeApprovalLease): boolean;
  mayReview(lease: NativeApprovalLease): boolean;
  approveOnce(lease: NativeApprovalLease): boolean;
  isApproved(lease: NativeApprovalLease): boolean;
  cancel(lease: NativeApprovalLease): void;
  dismiss(lease: NativeApprovalLease): void;
  resume(): void;
  finish(lease: NativeApprovalLease, response?: string | null): void;
}
export type EffectAuthority = Readonly<{ assertActive(): void; signal: AbortSignal; nativeSource?: NativeSigningSource; awaitForeground?(): Promise<void> }>;
export interface ApprovalEffects extends SigningHandoffReader {
  sign(snapshot: EventSnapshot, execution: EffectAuthority): Promise<unknown>;
  publishEvent(event: VerifiedSignedEvent, destinations: readonly string[], execution: EffectAuthority): Promise<readonly RelayOutcome[]>;
}
export interface TrustedApprovalOwner { assertActive(origin: ApprovalOrigin,domain?:'outbox'): void }
export type ApprovalItem = Readonly<{ id: string; origin: ApprovalOrigin; event: EventSnapshot; outbox?:OutboxPublicationPlan }>;
export type ApprovalSnapshot = Readonly<{ focusedSessionId: string | null; reviewPaused: boolean; current: ApprovalItem | null; pending: number; pendingSessionIds: readonly string[] }>;
type Entry = ApprovalItem & { requestId: string; lease: NativeApprovalLease; controller: AbortController | null; signingPending?: boolean; publicationStarted?: boolean };
const PER_SESSION = 4, GLOBAL = 16;
let nextPresentationId = 0;

function denied(): never { throw new Error('APPROVAL_DENIED'); }
function captureOrigin(origin: ApprovalOrigin): ApprovalOrigin {
  return Object.freeze({ sessionId: origin.sessionId, generation: origin.generation, epoch: origin.epoch, user: origin.user,
    publisher: origin.publisher, appId: origin.appId, version: origin.version, instanceId: origin.instanceId });
}
function current(entries: readonly Entry[], focus: string | null, paused: boolean, native: NativeApprovalLeasePort): ApprovalItem | null {
  if (paused || focus === null) return null;
  const entry = entries.find(item => item.origin.sessionId === focus && item.controller === null && native.mayReview(item.lease));
  return entry ? Object.freeze({ id: entry.id, origin: entry.origin, event: entry.event,...(entry.outbox?{outbox:entry.outbox}:{}) }) : null;
}

/** Presentation-only approval queue. Native code owns admission, expiry, keys, and lifecycle authority. */
export class ApprovalService {
  private readonly native: NativeApprovalLeasePort;
  private readonly owner: TrustedApprovalOwner;
  private readonly effects: ApprovalEffects;
  private entries: Entry[] = [];
  private listeners = new Set<() => void>();
  private focusedSessionId: string | null = null;
  private reviewPaused = false;
  private readonly foregroundState = new SigningForeground();
  private snapshot: ApprovalSnapshot;
  private readonly preparing:OutboxApprovalPreparation;
  private readonly closeRisks = new Map<string, number>();
  private readonly receipts=new WeakMap<readonly RelayOutcome[],OutboxPublicationReceipt>();
  constructor(native: NativeApprovalLeasePort, owner: TrustedApprovalOwner, effects: ApprovalEffects,planner?:OutboxPublicationPlanner) {
    this.native = native; this.owner = owner; this.effects = effects;
    this.snapshot = Object.freeze({ focusedSessionId: null, reviewPaused: false, current: null, pending: 0, pendingSessionIds: Object.freeze([]) });
    this.preparing=new OutboxApprovalPreparation(native,owner,planner,()=>this.foregroundState.active,(taken,plan)=>{
      if(nextPresentationId>=Number.MAX_SAFE_INTEGER)denied();
      this.entries.push({requestId:taken.requestId,id:`approval_${++nextPresentationId}`,origin:captureOrigin(taken.origin),event:plan.event,outbox:plan,lease:taken.lease,controller:null});
    },()=>this.publish());
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot = (): ApprovalSnapshot => this.snapshot;
  private publish() {
    let shown: ApprovalItem | null = null;
    try { shown = current(this.entries, this.focusedSessionId, this.reviewPaused || !this.foregroundState.active, this.native); } catch { shown = null; }
    const next = Object.freeze({ focusedSessionId: this.focusedSessionId, reviewPaused: this.reviewPaused, current: shown, pending: this.entries.length+this.preparing.origins().length, pendingSessionIds: Object.freeze([...new Set([...this.entries.map(entry => entry.origin.sessionId),...this.preparing.origins().map(origin=>origin.sessionId)])]) });
    if (next.focusedSessionId === this.snapshot.focusedSessionId && next.reviewPaused === this.snapshot.reviewPaused && next.pending === this.snapshot.pending && next.current?.id === this.snapshot.current?.id && next.pendingSessionIds.join() === this.snapshot.pendingSessionIds.join()) return;
    this.snapshot = next;
    for (const listener of this.listeners) try { listener(); } catch { /* UI observers never hold approval authority. */ }
  }
  private end(entry: Entry, cancel: boolean, response: string | null = null) {
    if (!this.entries.includes(entry)) return;
    if (response === null && entry.publicationStarted) this.closeRisks.set(entry.origin.sessionId, entry.origin.epoch);
    this.entries = this.entries.filter(item => item !== entry);
    try { if (cancel) this.native.cancel(entry.lease); } catch { /* Native lease remains authoritative. */ }
    try { entry.controller?.abort(); } catch { /* Effect cleanup cannot skip native terminal cleanup. */ }
    try { this.native.finish(entry.lease, response); } catch { /* Terminal native cleanup. */ }
  }
  hasCloseRisk(sessionId: string): boolean { return this.closeRisks.has(sessionId) || this.getSnapshot().pendingSessionIds.includes(sessionId); }
  outboxReceipt(results:readonly RelayOutcome[]):OutboxPublicationReceipt|null{return this.receipts.get(results)??null;}
  refresh() {
    this.preparing.refresh();
    for (const entry of this.entries) { try { if (!this.handoffPending(entry) && !this.native.isLive(entry.lease)) this.end(entry, false); } catch { this.end(entry, true); } }
    this.publish();
  }
  enqueue(token: string, destinationsFromTrustedConfig: unknown, expectedOrigin?: ApprovalOrigin): boolean {
    this.refresh();
    let taken: NativeTakenApproval | null;
    try { taken = this.native.take(token); } catch { return false; }
    if (!taken) return false;
    try {
      if (expectedOrigin && Object.keys(captureOrigin(expectedOrigin)).some(key => taken.origin[key as keyof ApprovalOrigin] !== expectedOrigin[key as keyof ApprovalOrigin])) denied();
      this.owner.assertActive(taken.origin,taken.outboxRequest?'outbox':undefined);
      const origins=[...this.entries.map(entry=>entry.origin),...this.preparing.origins()];
      if(origins.length>=GLOBAL||origins.filter(origin=>origin.sessionId===taken!.origin.sessionId).length>=PER_SESSION)denied();
      if(taken.outboxRequest){if(!this.preparing.start(taken))denied();return true;}
      const event = captureEventSnapshot(taken.event, taken.origin.user, destinationsFromTrustedConfig);
      if (event.event.kind === 22242 || event.event.kind === 24242 || this.entries.length >= GLOBAL || this.entries.filter(entry => entry.origin.sessionId === taken!.origin.sessionId).length >= PER_SESSION) denied();
      if (nextPresentationId >= Number.MAX_SAFE_INTEGER) denied();
      this.entries.push({ requestId: taken.requestId, id: `approval_${++nextPresentationId}`, origin: captureOrigin(taken.origin), event, lease: taken.lease, controller: null });
      this.publish(); return true;
    } catch {
      try { this.native.cancel(taken.lease); } catch { /* Rejecting admission must still finish the lease. */ }
      try { this.native.finish(taken.lease); } catch { /* Native cleanup failures cannot grant presentation. */ }
      return false;
    }
  }
  focus(sessionId: string | null) { for (const entry of this.entries) if (entry.controller && entry.origin.sessionId === this.focusedSessionId && sessionId !== this.focusedSessionId) this.end(entry, true); this.focusedSessionId = sessionId; this.publish(); }
  foreground() { this.foregroundState.setActive(true); this.publish(); }
  resume() {
    if (this.foregroundState.active && this.focusedSessionId !== null) {
      try { this.native.resume(); this.reviewPaused = false; } catch { /* Native review stays unavailable. */ }
    }
    this.publish();
  }
  reject(id: string) {
    this.refresh();
    if (this.snapshot.current?.id !== id) return;
    const entry = this.entries.find(candidate => candidate.id === id)!;
    this.end(entry, true); this.publish();
  }
  dismiss(id: string) {
    this.refresh();
    const item = this.snapshot.current;
    if (!item || item.id !== id) return;
    const entry = this.entries.find(candidate => candidate.id === id)!;
    try { this.native.dismiss(entry.lease); } catch { /* Cancel below still revokes the request. */ }
    this.end(entry, true); this.reviewPaused = true; this.publish();
  }
  background() {
    this.foregroundState.setActive(false);
    this.preparing.cancel(()=>true);
    this.reviewPaused = true;
    for (const entry of this.entries) if (entry.controller !== null && !this.handoffPending(entry)) this.end(entry, true);
    this.publish();
  }
  close(sessionId: string) { this.preparing.cancel(origin=>origin.sessionId===sessionId); for (const entry of this.entries) if (entry.origin.sessionId === sessionId) this.end(entry, true); this.closeRisks.delete(sessionId); this.publish(); }
  revisionChanged(epoch: number) { this.preparing.cancel(origin=>origin.epoch!==epoch); for (const entry of this.entries) if (entry.origin.epoch !== epoch) this.end(entry, true); for (const [id, value] of this.closeRisks) if (value !== epoch) this.closeRisks.delete(id); this.publish(); }
  private handoffState(entry: Entry) {
    try { return signingHandoffState(this.effects, this.native.signingSource?.(entry.lease)); } catch { return null; }
  }
  private handoffPending(entry: Entry): boolean {
    return entry.signingPending === true && !entry.publicationStarted && this.handoffState(entry) === 'pending';
  }
  private awaitForeground(entry: Entry): Promise<void> {
    if (!this.foregroundState.active && this.handoffState(entry) !== 'resumed') denied();
    return this.foregroundState.wait(entry.controller!.signal);
  }
  private authority(entry: Entry): EffectAuthority {
    const assertActive = () => {
      if (!this.foregroundState.active || (this.reviewPaused && this.handoffState(entry) !== 'resumed') || this.focusedSessionId !== entry.origin.sessionId || entry.controller?.signal.aborted || !this.entries.includes(entry)) denied();
      try { if (!this.native.isLive(entry.lease) || !this.native.isApproved(entry.lease)) denied(); } catch { denied(); }
      this.owner.assertActive(entry.origin,entry.outbox?'outbox':undefined);
    };
    return Object.freeze({ assertActive, awaitForeground: () => this.awaitForeground(entry), signal: entry.controller!.signal, nativeSource: this.native.signingSource?.(entry.lease) });
  }
  private async publishOutbox(entry:Entry,verified:VerifiedSignedEvent,execution:EffectAuthority):Promise<OutboxPublicationReceipt>{
    if(!entry.outbox||!this.native.publishOutbox)denied();
    const primary=captureRelayOutcomes(await this.native.publishOutbox(entry.lease,'primary',verified,entry.event.destinations,execution),entry.event.destinations,verified.id);execution.assertActive();
    let ancillary:readonly RelayOutcome[]|null=null;
    if(entry.outbox.ancillary){
      try { ancillary=await this.native.publishOutbox(entry.lease,'relay-list',entry.outbox.ancillary,entry.event.destinations,execution); }
      catch {
        execution.assertActive();
        // A bridge failure cannot establish whether a list frame reached a relay. Preserve primary ACKs.
        ancillary=entry.event.destinations.map(relay=>({relay,eventId:entry.outbox!.ancillary!.id,status:'unknown',reason:'relay-list result unavailable'}));
      }
    }
    execution.assertActive();return captureOutboxPublicationReceipt(entry.outbox,verified,primary,ancillary);
  }
  async approve(id: string): Promise<readonly RelayOutcome[]> {
    this.refresh();
    const item = this.snapshot.current;
    if (!item || item.id !== id) denied();
    const entry = this.entries.find(candidate => candidate.id === id)!;
    let response: string | null = null;
    let publicationStarted = false;
    try {
      this.owner.assertActive(entry.origin,entry.outbox?'outbox':undefined);
      if (this.native.prepareSigning && !this.native.prepareSigning(entry.lease, entry.event)) denied();
      if (!this.native.mayReview(entry.lease) || !this.native.approveOnce(entry.lease)) denied();
      entry.controller = new AbortController(); this.publish();
      const execution = this.authority(entry);
      execution.assertActive();
      entry.signingPending = true;
      const signed = await this.effects.sign(entry.event, execution);
      await execution.awaitForeground?.(); entry.signingPending = false;
      execution.assertActive();
      const verified = validateSignedEvent(entry.event, signed);
      execution.assertActive();
      if(entry.outbox){
        publicationStarted = true; entry.publicationStarted = true;
        const receipt=await this.publishOutbox(entry,verified,execution);execution.assertActive();response=JSON.stringify(receipt.response);
        if (receipt.primary.outcomes.some(row => row.status === 'unknown') || receipt.ancillary?.outcomes.some(row => row.status === 'unknown')) this.closeRisks.set(entry.origin.sessionId, entry.origin.epoch);
        this.receipts.set(receipt.primary.outcomes,receipt);return receipt.primary.outcomes;
      }
      publicationStarted = true; entry.publicationStarted = true;
      const outcomes = await this.effects.publishEvent(verified, entry.event.destinations, execution);
      execution.assertActive();
      const captured = captureRelayOutcomes(outcomes, entry.event.destinations, verified.id);
      if (captured.some(row => row.status === 'unknown')) this.closeRisks.set(entry.origin.sessionId, entry.origin.epoch);
      const accepted = captured.some(row => row.status === 'accepted');
      const completedResponse = JSON.stringify({ type: 'relay.publish.result', id: entry.requestId, ok: accepted,
        ...(accepted ? { event: verified, eventId: verified.id } : { error: captured.some(row => row.status === 'unknown') ? 'publication result unknown' : 'no relay accepted the event' }) });
      execution.assertActive();
      response = completedResponse;
      return captured;
    } catch (error) {
      if (publicationStarted && this.entries.includes(entry)) this.closeRisks.set(entry.origin.sessionId, entry.origin.epoch);
      throw error;
    } finally { this.end(entry, response === null, response); this.publish(); }
  }
}
