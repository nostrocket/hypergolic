/** Durable descriptors contain no WebView state or signing requests. */
export interface NappletDescriptor {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly appId: string;
  readonly version: string;
  readonly source: 'bundled' | 'published';
  /** Exact signed kind-35129 event selected for this published version. */
  readonly eventId?: string;
}
export interface Workspace {
  readonly sessions: readonly NappletDescriptor[];
  readonly focusedId: string | null;
  readonly overview: boolean;
}
export const emptyWorkspace = (): Workspace => ({ sessions: [], focusedId: null, overview: true });

export function openNapplet(state: Workspace, descriptor: NappletDescriptor): Workspace {
  if (state.sessions.some(session => session.id === descriptor.id)) return focusNapplet(state, descriptor.id);
  return { sessions: [...state.sessions, Object.freeze({ ...descriptor })], focusedId: descriptor.id, overview: false };
}
/** An accepted published revision gets a new native session at its existing card position. */
export function replacePublishedNapplet(state: Workspace, oldId: string, next: NappletDescriptor): Workspace {
  const index = state.sessions.findIndex(session => session.id === oldId);
  const old = state.sessions[index];
  if (!old || old.source !== 'published' || next.source !== 'published' || next.id === oldId ||
      state.sessions.some(session => session.id === next.id) || old.publisher !== next.publisher || old.appId !== next.appId ||
      old.eventId === next.eventId) throw new Error('Invalid published update');
  const sessions = [...state.sessions];
  sessions[index] = Object.freeze({ ...next });
  return { sessions, focusedId: next.id, overview: false };
}
export function focusNapplet(state: Workspace, id: string): Workspace {
  if (!state.sessions.some(session => session.id === id)) return state;
  return { ...state, focusedId: id, overview: false };
}
export function adjacentNapplet(state: Workspace, direction: -1 | 1): string | null {
  if (state.focusedId === null) return null;
  const index = state.sessions.findIndex(session => session.id === state.focusedId);
  return state.sessions[index + direction]?.id ?? null;
}
/** Call only after the trusted close warning was accepted (or known clean). */
export function closeNapplet(state: Workspace, id: string): Workspace {
  if (!state.sessions.some(session => session.id === id)) return state;
  const sessions = state.sessions.filter(session => session.id !== id);
  // Keep an existing focus as the return destination, but never leave overview.
  const focusedId = state.focusedId === id ? null : state.focusedId;
  return { sessions, focusedId, overview: true };
}
export function showOverview(state: Workspace): Workspace { return { ...state, overview: true }; }

export interface WorkspaceSnapshot {
  readonly schema: 1;
  readonly sessions: readonly NappletDescriptor[];
  readonly lastActiveId: string | null;
}
export function snapshotWorkspace(state: Workspace): WorkspaceSnapshot {
  return { schema: 1, sessions: state.sessions.map(item => ({ ...item })), lastActiveId: state.focusedId };
}
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
export function restoreWorkspace(value: unknown): Workspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid workspace');
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schema !== 1 || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 64) throw new Error('Invalid workspace');
  const ids = new Set<string>();
  const sessions = snapshot.sessions.map((entry: unknown): NappletDescriptor => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid napplet');
    const item = entry as Record<string, unknown>;
    if (!bounded(item.id, 80) || !/^[A-Za-z0-9_-]+$/.test(item.id) || ids.has(item.id) ||
        !bounded(item.title, 128) || !bounded(item.publisher, 128) || !bounded(item.appId, 256) ||
        !bounded(item.version, 128) || (item.source !== 'bundled' && item.source !== 'published')) throw new Error('Invalid napplet');
    if (item.source === 'published' && (typeof item.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(item.eventId))) throw new Error('Invalid published event pin');
    if (item.source === 'bundled' && item.eventId !== undefined) throw new Error('Invalid bundled event pin');
    ids.add(item.id);
    return Object.freeze({ id: item.id, title: item.title, publisher: item.publisher, appId: item.appId, version: item.version, source: item.source,
      ...(item.source === 'published' ? { eventId: item.eventId as string } : {}) });
  });
  if (snapshot.lastActiveId !== null && (typeof snapshot.lastActiveId !== 'string' || !ids.has(snapshot.lastActiveId))) throw new Error('Invalid focus');
  return { sessions, focusedId: snapshot.lastActiveId as string | null, overview: sessions.length === 0 || snapshot.lastActiveId === null };
}
