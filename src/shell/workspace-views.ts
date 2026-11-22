import type { NappletDescriptor, Workspace } from './workspace.ts';
import { MAX_LOADED_VIEWS } from './workspace-activity.ts';

type Suspension = {
  canSuspend(session: NappletDescriptor): boolean;
  trySuspend(session: NappletDescriptor): boolean;
};

/** Per-workspace resident views, ordered from least to most recently focused.
 * Workspace cards and their durable identities have a separate lifetime. */
export class WorkspaceViews {
  private workspace: Workspace;
  private loaded: ReadonlySet<string> = new Set();
  private guard: Suspension | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(initial: Workspace) {
    this.workspace = initial;
    this.update(initial);
  }

  getSnapshot = () => this.loaded;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  bind(guard: Suspension) {
    this.guard = guard;
    return () => { if (this.guard === guard) this.guard = null; };
  }

  private publish(ids: Set<string>) {
    this.loaded = ids;
    for (const listener of this.listeners) listener();
  }

  private candidates(ids: ReadonlySet<string>) {
    const byId = new Map(this.workspace.sessions.map(session => [session.id, session]));
    return Array.from(ids, id => byId.get(id)).filter((session): session is NappletDescriptor =>
      session !== undefined && session.id !== this.workspace.focusedId);
  }

  canLoadView(ids: readonly string[]): boolean {
    return this.loaded.size < MAX_LOADED_VIEWS || ids.some(id => this.loaded.has(id)) ||
      this.candidates(this.loaded).some(session => this.guard?.canSuspend(session));
  }

  private makeRoom(ids: Set<string>): boolean {
    if (ids.size < MAX_LOADED_VIEWS) return true;
    const victim = this.candidates(ids).find(session => this.guard?.trySuspend(session));
    return victim !== undefined && ids.delete(victim.id);
  }

  /** Called synchronously at the link broker's commit, while its source is still protected. */
  admitView(id: string): boolean {
    if (this.loaded.has(id) || this.loaded.size < MAX_LOADED_VIEWS) return true;
    const next = new Set(this.loaded);
    if (!this.makeRoom(next)) return false;
    this.publish(next);
    return true;
  }

  update(workspace: Workspace) {
    const present = new Set(workspace.sessions.map(session => session.id));
    const next = new Set([...this.loaded].filter(id => present.has(id)));
    const focus = workspace.overview ? null : workspace.focusedId;
    if (focus && present.has(focus) && (next.delete(focus) || this.makeRoom(next))) next.add(focus);
    this.workspace = workspace;
    const previous = [...this.loaded];
    if (next.size !== previous.length || [...next].some((id, index) => id !== previous[index])) this.publish(next);
  }

  trimBackground() {
    const next = new Set(this.loaded);
    for (const session of this.candidates(next)) {
      if (this.guard?.trySuspend(session)) next.delete(session.id);
    }
    if (next.size !== this.loaded.size) this.publish(next);
  }
}
