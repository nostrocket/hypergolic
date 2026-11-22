import { WorkspaceViews } from '../shell/workspace-views.ts';
import { replacePublishedNapplet, restoreWorkspace, snapshotWorkspace, type Workspace, type WorkspaceSnapshot } from '../shell/workspace.ts';
import { encodeSnapshot, snapshot } from './codec.ts';
import type { WorkspaceRecord, WorkspaceStorage, WorkspaceUpdate } from './database.ts';
import { fail, sanitize, type Binding, type StorageCode } from './ports.ts';

export interface WorkspaceState {
  readonly workspace: Workspace;
  readonly saving: boolean;
  readonly error: StorageCode | null;
}
export interface WorkspaceController {
  readonly views: WorkspaceViews;
  canLoadView(ids: readonly string[]): boolean;
  admitView(id: string): boolean;
  getSnapshot(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  change(workspace: Workspace): void;
  acceptUpdate(update: WorkspaceUpdate): Promise<void>;
  flush(): Promise<void>;
  freeze(): void;
  resume(): void;
  revoke(): void;
}

function immutable(workspace: Workspace, previous?: Workspace): Workspace {
  if (typeof workspace.overview !== 'boolean') throw new Error('Invalid overview state');
  const saved = snapshot(snapshotWorkspace(workspace));
  // Deferred native actions capture the current descriptor. Preserve it only when the
  // caller retained the exact immutable object from the previous workspace.
  const existing = new Set(previous?.sessions);
  const sessions = Object.freeze(saved.sessions.map((normalized, index) => {
    const original = workspace.sessions[index]!;
    return existing.has(original) ? original : normalized;
  }));
  return Object.freeze({ ...restoreWorkspace(saved), sessions, pins: saved.pins, overview: workspace.overview });
}

export async function openWorkspaceController(
  binding: Binding<WorkspaceStorage>, seed: () => Workspace, assertAvailable: (workspace: Workspace) => void,
): Promise<WorkspaceController> {
  let record: WorkspaceRecord;
  let initial: Workspace;
  try {
    const loaded = await binding.port.load();
    initial = immutable(loaded === null ? seed() : restoreWorkspace(loaded.snapshot));
    assertAvailable(initial);
    record = loaded ?? await binding.port.save(snapshotWorkspace(initial), null);
  } catch (error) { binding.revoke(); throw sanitize(error); }
  let state: WorkspaceState = Object.freeze({ workspace: initial, saving: false, error: null });
  const views = new WorkspaceViews(initial);
  let editable = true;
  let pending: WorkspaceSnapshot | null = null;
  let updating: Promise<void> | null = null;
  let flushing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  function publish(next: WorkspaceState): void {
    const changed = state.workspace !== next.workspace;
    state = Object.freeze(next);
    if (changed) views.update(next.workspace);
    for (const listener of listeners) listener();
  }
  function stop(code: StorageCode): void {
    pending = null;
    binding.revoke();
    publish({ ...state, saving: false, error: code });
  }
  async function drain(): Promise<void> {
    while (pending !== null && state.error === null) {
      const next = pending;
      pending = null;
      if (encodeSnapshot(next) === encodeSnapshot(record.snapshot)) continue;
      const saved = await binding.port.save(next, record.revision);
      if (state.error === null) record = saved;
    }
  }
  function schedule(): void {
    if (flushing !== null || state.error !== null) return;
    flushing = Promise.resolve().then(drain).catch(error => {
      if (state.error === null) stop(sanitize(error).code);
    }).finally(() => {
      flushing = null;
      if (pending !== null && state.error === null) schedule();
      else if (state.error === null) publish({ ...state, saving: false });
    });
  }
  function flush(): Promise<void> { return flushing === null ? Promise.resolve() : flushing.then(flush); }
  async function commitUpdate(update: WorkspaceUpdate): Promise<void> {
    await flush();
    const active = () => {
      if (!editable || state.error !== null) fail('REVOKED');
      update.assertActive();
    };
    active();
    const next = immutable(replacePublishedNapplet(state.workspace, update.previous.id, update.next));
    assertAvailable(next);
    const saved = await binding.port.save(snapshotWorkspace(next), record.revision, {update: {...update, assertActive: active}});
    record = saved;
    if (!state.error) publish({workspace: next, saving: false, error: null});
  }
  return Object.freeze({
    views,
    canLoadView: (ids: readonly string[]) => editable && !updating && !state.error && views.canLoadView(ids),
    admitView: (id: string) => editable && !updating && !state.error && views.admitView(id),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change: (workspace: Workspace) => {
      if (!editable || updating || state.error !== null) return;
      try {
        const next = immutable(workspace, state.workspace);
        assertAvailable(next);
        pending = snapshotWorkspace(next);
        publish({ workspace: next, saving: true, error: null });
        schedule();
      } catch (error) { stop(sanitize(error).code); }
    },
    acceptUpdate(update: WorkspaceUpdate) {
      if (!editable || updating || state.error) return Promise.reject(new Error('Published update could not be added'));
      updating = commitUpdate(update).finally(() => { updating = null; });
      return updating;
    },
    flush: () => updating ? updating.catch(() => undefined).then(flush) : flush(),
    freeze: () => { editable = false; },
    resume: () => { if (state.error === null) editable = true; },
    revoke: () => { if (state.error === null) stop('REVOKED'); },
  });
}
