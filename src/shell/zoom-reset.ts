import type {NappletDescriptor, Workspace} from './workspace.ts';

export interface NativeZoomView {resetZoom(sessionId: string, generation: string): Promise<boolean>}
export type ZoomResetTarget = Readonly<{sessionId: string; reset(): Promise<boolean>}>;
export type ZoomResetRegistration = (target: ZoomResetTarget) => () => void;
type NativeZoomState = Readonly<{view: NativeZoomView | null; generation: string | null; available: boolean}>;
export type NativeZoomReply = Readonly<{type: 'zoom-reset'; sessionId: string; generation: string; sequence: number; ok: boolean}>;
type PendingZoom = {sessionId: string; generation: string; sequence: number; deadline: number; timer: ReturnType<typeof setTimeout>; resolve(value: boolean): void};

/** A prop command has one bounded waiter; native also rejects expired or replayed commands. */
export class NativeZoomRequests {
  private sequence = 0;
  private pending: PendingZoom | null = null;
  private readonly send: (raw: string) => void;
  private readonly now: () => number;
  constructor(send: (raw: string) => void, now: () => number = Date.now) {this.send = send; this.now = now;}
  request(sessionId: string, generation: string): Promise<boolean> {
    this.cancel();
    if (this.sequence >= Number.MAX_SAFE_INTEGER) return Promise.resolve(false);
    const sequence = ++this.sequence;
    return new Promise(resolve => {
      const issuedAt = this.now();
      this.pending = {sessionId, generation, sequence, resolve, deadline: issuedAt + 1_100,
        timer: setTimeout(() => {if (this.pending?.sequence === sequence) this.finish(false);}, 1_100)};
      try {this.send(JSON.stringify({sessionId, generation, sequence, issuedAt}));}
      catch {this.finish(false);}
    });
  }
  cancel(clearProp = true): void {this.finish(false, clearProp);}
  receive(value: unknown): void {
    const pending = this.pending;
    if (!pending || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = value as NativeZoomReply;
    if (Object.keys(row).length !== 5 || row.type !== 'zoom-reset' || row.sessionId !== pending.sessionId ||
      row.generation !== pending.generation || row.sequence !== pending.sequence || typeof row.ok !== 'boolean') return;
    let timely = false;
    try {timely = this.now() < pending.deadline;} catch { /* Unavailable timing cannot confirm a reset. */ }
    this.finish(row.ok && timely);
  }
  private finish(result: boolean, clearProp = true): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null; clearTimeout(pending.timer);
    try {if (clearProp) this.send('');} catch { /* The waiter still settles if clearing the prop fails. */ }
    pending.resolve(result);
  }
}

export class ZoomResetTargets {
  private readonly targets = new Map<string, ZoomResetTarget>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  getSnapshot = (): number => this.revision;
  private changed(): void {this.revision++; for (const listener of this.listeners) listener();}
  register(target: ZoomResetTarget): () => void {
    this.targets.set(target.sessionId, target);
    this.changed();
    return () => {
      if (this.targets.get(target.sessionId) !== target) return;
      this.targets.delete(target.sessionId); this.changed();
    };
  }
  get(id: string): ZoomResetTarget | null {return this.targets.get(id) ?? null;}
}

/** An old ref or ready generation never resolves to its replacement. */
export function createZoomResetTarget(sessionId: string, generation: string, view: NativeZoomView,
  current: () => NativeZoomState): ZoomResetTarget {
  return Object.freeze({sessionId, async reset() {
    const state = current();
    if (!state.available || state.view !== view || state.generation !== generation) return false;
    try {return await view.resetZoom(sessionId, generation) === true;} catch {return false;}
  }});
}

export interface ZoomResetContext {
  workspace: Workspace; identity: string | undefined; lifetime: unknown; active: boolean; blocked: boolean;
}
type Selection = Readonly<{session: NappletDescriptor; identity: string | undefined; lifetime: unknown; target: ZoomResetTarget}>;
type Schedule = (run: () => void) => () => void;
function currentSelection(selection: Selection, context: ZoomResetContext): boolean {
  return context.active && !context.blocked && !context.workspace.overview &&
    context.workspace.focusedId === selection.session.id && context.workspace.sessions.includes(selection.session) &&
    context.identity === selection.identity && context.lifetime === selection.lifetime;
}

/** One explicit menu action; cancellation also fences a late native outcome. */
export class ZoomResetAction {
  private revision = 0;
  private cancelFrame: (() => void) | null = null;
  cancel(): void {this.revision++; this.cancelFrame?.(); this.cancelFrame = null;}
  request(session: NappletDescriptor, target: ZoomResetTarget | null, read: () => ZoomResetContext,
    dismiss: () => void, schedule: Schedule, unavailable: () => void): void {
    this.cancel();
    const context = read(), revision = this.revision;
    if (!context.active || context.blocked || context.workspace.overview ||
      context.workspace.focusedId !== session.id || !context.workspace.sessions.includes(session)) return;
    if (!target || target.sessionId !== session.id) {unavailable(); return;}
    const selection = {session, identity: context.identity, lifetime: context.lifetime, target};
    if (!currentSelection(selection, context)) return;
    dismiss();
    this.cancelFrame = schedule(() => {
      this.cancelFrame = null;
      void this.invoke(selection, revision, read, unavailable);
    });
  }
  private async invoke(selection: Selection, revision: number, read: () => ZoomResetContext, unavailable: () => void): Promise<void> {
    if (this.revision !== revision || !currentSelection(selection, read())) return;
    let result = false;
    try {result = await selection.target.reset();} catch { /* An unavailable native view is not retried. */ }
    if (!result && this.revision === revision && currentSelection(selection, read())) unavailable();
  }
}
