export const CLOSE_CHECK_SERVICE = 'hypergolic.close-check.v1';
export const CLOSE_CHECK_TIMEOUT_MS = 500;
export type CloseState = 'clean' | 'dirty' | 'unknown';
export type CloseCheckRequest = Readonly<{sessionId: string; generation: string; id: string}>;
export type CloseCheckEvent = CloseCheckRequest & Readonly<{type: 'close-check'; state: CloseState}>;
type Pending = {request: CloseCheckRequest; deadline: number; timer: ReturnType<typeof setTimeout>; resolve(state: CloseState | null): void};

/** One ephemeral check; neither guest clean claims nor correlations survive a lifecycle change. */
export class CloseCheckCoordinator {
  private readonly generations = new Map<string, string>();
  private pending: Pending | null = null;
  private readonly newId: () => string;
  private readonly now: () => number;
  constructor(newId: () => string, now: () => number = () => performance.now()) { this.newId = newId; this.now = now; }
  isPending(): boolean { return this.pending !== null; }
  ready(sessionId: string, generation: string): void {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(generation)) return;
    if (this.generations.get(sessionId) !== generation) this.cancel(sessionId);
    this.generations.set(sessionId, generation);
  }
  forget(sessionId: string): void { this.cancel(sessionId); this.generations.delete(sessionId); }
  cancel(sessionId?: string): void {
    if (this.pending && (sessionId === undefined || this.pending.request.sessionId === sessionId)) this.finish(null);
  }
  private finish(state: CloseState | null): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(state); }
  }
  request(sessionId: string, send: (request: CloseCheckRequest) => void): Promise<CloseState | null> {
    this.cancel();
    const generation = this.generations.get(sessionId);
    if (!generation) return Promise.resolve('unknown');
    const id = this.newId();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return Promise.resolve('unknown');
    const request = Object.freeze({sessionId, generation, id});
    return new Promise(resolve => {
      this.pending = {request, deadline: this.now() + CLOSE_CHECK_TIMEOUT_MS,
        timer: setTimeout(() => this.finish('unknown'), CLOSE_CHECK_TIMEOUT_MS), resolve};
      try { send(request); } catch { this.finish('unknown'); }
    });
  }
  receive(event: CloseCheckEvent): void {
    const pending = this.pending;
    if (!pending || event.id !== pending.request.id || event.sessionId !== pending.request.sessionId ||
        event.generation !== pending.request.generation) return;
    const valid = Object.keys(event).length === 5 && ['clean', 'dirty', 'unknown'].includes(event.state);
    this.finish(valid && this.now() < pending.deadline ? event.state : 'unknown');
  }
}
