import { pinArtwork } from './pin-artwork.ts';
import type { PublishedLaunchIcon } from '../napplets/verified-launch-metadata.ts';
import { defaultPins, pinnedNapplets, pinKey } from './pins.ts';
import {supportsLegacyReadOnly} from '../napplets/legacy-read-only.ts';
import {matchesPublishedAppKey,snapshotEventId} from '../napplets/published-identity.ts';

/** Durable descriptors contain no WebView state or signing requests. */
export interface NappletDescriptor {
  readonly icon?: PublishedLaunchIcon;
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly appId: string;
  readonly version: string;
  readonly source: 'bundled' | 'published';
  /** Exact signed event selected for this published version. */
  readonly eventId?: string;
  /** Explicit consent for this immutable pin, scoped by the identity workspace. */
  readonly legacyReadOnly?: true;
  readonly legacyReadOnlyUser?: string;
}
export function samePublishedPin(left: NappletDescriptor, right: NappletDescriptor): boolean {
  return left.source === 'published' && right.source === 'published' && left.id === right.id &&
    left.publisher === right.publisher && left.appId === right.appId &&
    left.eventId === right.eventId && left.version === right.version;
}

export interface Workspace {
  readonly home?: boolean;
  readonly gameControls?: readonly string[];
  readonly pins?: readonly NappletDescriptor[];
  readonly sessions: readonly NappletDescriptor[];
  readonly focusedId: string | null;
  readonly overview: boolean;
}
export const emptyWorkspace = (): Workspace => ({ sessions: [], focusedId: null, overview: true, home: true, pins: defaultPins() });

export function usesGameControls(state: Workspace, session: NappletDescriptor): boolean {
  return state.gameControls?.includes(pinKey(session)) ?? false;
}
export function setGameControls(state: Workspace, session: NappletDescriptor, enabled: boolean): Workspace {
  const keys = new Set(state.gameControls);
  const key = pinKey(session);
  if (enabled) keys.add(key);
  else keys.delete(key);
  return {...state, gameControls: [...keys]};
}

export function openNapplet(state: Workspace, descriptor: NappletDescriptor): Workspace {
  if (state.sessions.some(session => session.id === descriptor.id)) return focusNapplet(state, descriptor.id);
  return { ...state, home: false, sessions: [...state.sessions, Object.freeze({ ...descriptor })], focusedId: descriptor.id, overview: false };
}
/** An accepted published revision gets a new native session at its existing card position. */
export function replacePublishedNapplet(state: Workspace, oldId: string, next: NappletDescriptor): Workspace {
  const index = state.sessions.findIndex(session => session.id === oldId);
  const old = state.sessions[index];
  if (!old || old.source !== 'published' || next.source !== 'published' || next.id === oldId ||
      state.sessions.some(session => session.id === next.id) || old.publisher !== next.publisher || old.appId !== next.appId ||
      old.eventId === next.eventId || snapshotEventId(old.appId)) throw new Error('Invalid published update');
  const sessions = [...state.sessions];
  sessions[index] = Object.freeze({ ...next });
  return { ...state, home: false, sessions, focusedId: next.id, overview: false,
    ...(state.pins ? {pins: state.pins.map(pin => pinKey(pin) === pinKey(old) ? {...next} : pin)} : {}) };
}
export function focusNapplet(state: Workspace, id: string): Workspace {
  if (!state.sessions.some(session => session.id === id)) return state;
  return { ...state, focusedId: id, overview: false, home: false };
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
  return { ...state, sessions, focusedId, overview: true, home: sessions.length === 0 };
}
export function showOverview(state: Workspace): Workspace { return { ...state, overview: true, home: false }; }

export interface WorkspaceSnapshot {
  readonly schema: 1 | 2;
  readonly gameControls?: readonly string[];
  readonly pins?: readonly NappletDescriptor[];
  readonly home?: boolean;
  readonly sessions: readonly NappletDescriptor[];
  readonly lastActiveId: string | null;
}
export function snapshotWorkspace(state: Workspace): WorkspaceSnapshot {
  return { schema: 2, ...(state.gameControls?.length ? {gameControls: state.gameControls} : {}), sessions: state.sessions.map(item => ({ ...item })), lastActiveId: state.focusedId,
    pins: pinnedNapplets(state).map(item => ({...item})), home: state.home ?? state.sessions.length === 0 };
}
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
export function restoreWorkspace(value: unknown): Workspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid workspace');
  const snapshot = value as Record<string, unknown>;
  if ((snapshot.schema !== 1 && snapshot.schema !== 2) || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 64) throw new Error('Invalid workspace');
  const ids = new Set<string>();
  const sessions = snapshot.sessions.map((entry: unknown): NappletDescriptor => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid napplet');
    const item = entry as Record<string, unknown>;
    if (!bounded(item.id, 80) || !/^[A-Za-z0-9_-]+$/.test(item.id) || ids.has(item.id) ||
        !bounded(item.title, 128) || !bounded(item.publisher, 128) || !bounded(item.appId, 256) ||
        !bounded(item.version, 128) || (item.source !== 'bundled' && item.source !== 'published')) throw new Error('Invalid napplet');
    if (item.source === 'published' && (typeof item.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(item.eventId) ||
        !matchesPublishedAppKey(item.appId,item.eventId))) throw new Error('Invalid published event pin');
    if (item.source === 'bundled' && item.eventId !== undefined) throw new Error('Invalid bundled event pin');
    if (item.legacyReadOnly !== undefined && (item.legacyReadOnly !== true || typeof item.legacyReadOnlyUser !== 'string' || !/^[0-9a-f]{64}$/.test(item.legacyReadOnlyUser) || item.source !== 'published' ||
        !supportsLegacyReadOnly({publisher: item.publisher, appId: item.appId, eventId: item.eventId as string, version: item.version}))) throw new Error('Invalid legacy read-only pin');
    if (item.legacyReadOnlyUser !== undefined && item.legacyReadOnly !== true) throw new Error('Unbound legacy user');
    ids.add(item.id);
    return Object.freeze({ ...(item.icon === undefined ? {} : {icon: pinArtwork(item.icon)}), id: item.id, title: item.title, publisher: item.publisher, appId: item.appId, version: item.version, source: item.source,
      ...(item.source === 'published' ? { eventId: item.eventId as string } : {}), ...(item.legacyReadOnly === true ? {legacyReadOnly: true as const, legacyReadOnlyUser: item.legacyReadOnlyUser as string} : {}) });
  });
  if (snapshot.lastActiveId !== null && (typeof snapshot.lastActiveId !== 'string' || !ids.has(snapshot.lastActiveId))) throw new Error('Invalid focus');
  let pins: readonly NappletDescriptor[] = defaultPins();
  let home = sessions.length === 0;
  if (snapshot.schema === 2) {
    if (!Array.isArray(snapshot.pins) || typeof snapshot.home !== 'boolean') throw new Error('Invalid Home');
    pins = restoreWorkspace({schema: 1, sessions: snapshot.pins, lastActiveId: null}).sessions;
    if (new Set(pins.map(pinKey)).size !== pins.length) throw new Error('Duplicate shortcut');
    home = snapshot.home;
  }
  const controls = snapshot.gameControls;
  if (controls !== undefined && (!Array.isArray(controls) || !controls.every(key => bounded(key, 2400)))) throw new Error('Invalid game controls');
  return { ...(controls?.length ? {gameControls: Object.freeze([...controls])} : {}), sessions, pins, home, focusedId: snapshot.lastActiveId as string | null, overview: home || sessions.length === 0 || snapshot.lastActiveId === null };
}
