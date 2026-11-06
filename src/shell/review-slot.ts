type Origin = Readonly<{sessionId: string; generation: string; epoch: number}>;
type Candidate = Readonly<{id: string; origin: Origin}>;
type ReviewLane = 'approval' | 'upload' | 'routing';
type Claim = Readonly<{lane: ReviewLane; item: Candidate}>;
type ReviewSource = {
  getSnapshot(): Readonly<{current: Candidate | null; focusedSessionId?: string | null}>;
  subscribe(listener: () => void): () => void;
};
const same = (left: Claim | null, right: Claim | null): boolean =>
  left === right || left !== null && right !== null && left.lane === right.lane &&
  left.item.id === right.item.id && left.item.origin.sessionId === right.item.origin.sessionId &&
  left.item.origin.generation === right.item.origin.generation &&
  left.item.origin.epoch === right.item.origin.epoch;
const claim = (lane: ReviewLane, item: Candidate | null): Claim | null => item ? {lane, item} : null;

export class ReviewBusyError extends Error {
  constructor() { super('review busy'); this.name = 'ReviewBusyError'; }
}

/** Presentation arbitration only. Native owners still control review eligibility and effects. */
export class ReviewSlot {
  private current: Claim | null = null;
  private routing: Candidate | null = null;
  private heldApproval: Candidate | null = null;
  private foreground = true;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: readonly (() => void)[];

  private readonly approval: ReviewSource;
  private readonly upload: ReviewSource;
  private readonly epoch: () => number | null;

  constructor(approval: ReviewSource, upload: ReviewSource,
    epoch: () => number | null, subscribeIdentity: (listener: () => void) => () => void) {
    this.approval = approval; this.upload = upload; this.epoch = epoch;
    this.subscriptions = [approval.subscribe(this.refresh), upload.subscribe(this.refresh), subscribeIdentity(this.refresh)];
    this.refresh();
  }
  getSnapshot = (): Claim | null => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  owns(lane: ReviewLane, id: string): boolean {
    return this.current?.lane === lane && this.current.item.id === id;
  }
  refresh = (): void => {
    const epoch = this.epoch();
    const signing = this.approval.getSnapshot();
    if (this.heldApproval && (this.heldApproval.origin.epoch !== epoch ||
      this.heldApproval.origin.sessionId !== signing.focusedSessionId)) this.heldApproval = null;
    if (!this.foreground || this.routing?.origin.epoch !== epoch) this.routing = null;
    // The visible claim clears on pause. Same-owner signing can resume after an external signer handoff.
    const eligible = this.foreground ? [claim('approval', this.heldApproval ?? signing.current),
      claim('upload', this.upload.getSnapshot().current), claim('routing', this.routing)]
      .filter((candidate): candidate is Claim => candidate !== null && candidate.item.origin.epoch === epoch) : [];
    const next = eligible.find(candidate => same(candidate, this.current)) ?? eligible[0] ?? null;
    if (same(next, this.current)) return;
    this.current = next;
    for (const listener of this.listeners) try { listener(); } catch { /* Presentation observers do not own the slot. */ }
  };
  setForeground(value: boolean): void {
    this.foreground = value; this.refresh();
  }
  reserveRouting(item: Candidate): boolean {
    this.refresh();
    if (same(this.current, claim('routing', item))) return true;
    if (this.current || !this.foreground || this.epoch() !== item.origin.epoch) return false;
    this.routing = item; this.refresh();
    return this.owns('routing', item.id);
  }
  releaseRouting(id: string): void {
    if (this.routing?.id !== id) return;
    this.routing = null; this.refresh();
  }
  holdApproval(item: Candidate): boolean {
    this.refresh();
    if (this.heldApproval || !same(this.current, claim('approval', item))) return false;
    this.heldApproval = item; return true;
  }
  releaseApproval(id: string): void {
    if (this.heldApproval?.id !== id) return;
    this.heldApproval = null; this.refresh();
  }
  close(sessionId: string): void {
    if (this.heldApproval?.origin.sessionId === sessionId) this.heldApproval = null;
    if (this.routing?.origin.sessionId === sessionId) this.routing = null;
    this.refresh();
  }
  dispose(): void {
    this.heldApproval = null;
    this.setForeground(false);
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.listeners.clear();
  }
}
