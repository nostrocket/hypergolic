import { restoreWorkspace, snapshotWorkspace, type Workspace, type WorkspaceSnapshot } from '../shell/workspace.ts';
import { encodeSnapshot, snapshot } from './codec.ts';
import type { WorkspaceRecord, WorkspaceStorage } from './database.ts';
import { sanitize, type Binding, type StorageCode } from './ports.ts';

export interface WorkspaceState {
  readonly workspace: Workspace;
  readonly saving: boolean;
  readonly error: StorageCode | null;
}
export interface WorkspaceController {
  getSnapshot(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  change(workspace: Workspace): void;
  flush(): Promise<void>;
  freeze(): void;
  resume(): void;
  revoke(): void;
}

function immutable(workspace: Workspace): Workspace {
  if (typeof workspace.overview !== 'boolean') throw new Error('Invalid overview state');
  const saved = snapshot(snapshotWorkspace(workspace));
  return Object.freeze({ ...restoreWorkspace(saved), sessions: saved.sessions, overview: workspace.overview });
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
  let editable = true;
  let pending: WorkspaceSnapshot | null = null;
  let flushing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  function publish(next: WorkspaceState): void {
    state = Object.freeze(next);
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
  return Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change: (workspace: Workspace) => {
      if (!editable || state.error !== null) return;
      try {
        const next = immutable(workspace);
        assertAvailable(next);
        pending = snapshotWorkspace(next);
        publish({ workspace: next, saving: true, error: null });
        schedule();
      } catch (error) { stop(sanitize(error).code); }
    },
    flush,
    freeze: () => { editable = false; },
    resume: () => { if (state.error === null) editable = true; },
    revoke: () => { if (state.error === null) stop('REVOKED'); },
  });
}
