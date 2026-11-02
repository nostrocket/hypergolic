import {randomUUID} from 'expo-crypto';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {AppState} from 'react-native';
import type {HostEvent} from '../runtime/NappletHost';
import {CloseCheckCoordinator, type CloseCheckRequest} from './close-check';
import type {Workspace} from './workspace';

type Options = {
  workspace: RefObject<Workspace>; blocked: boolean; identity?: string; lifetime: unknown;
  pendingApprovals?: ReadonlySet<string>; canCloseWithoutWarning?: (id: string) => boolean;
  onClean(id: string): void; onWarning(id: string): void; onHostEvent?: (event: HostEvent) => void;
};

/** Keeps correlation and lifecycle separate from workspace motion and trusted warning presentation. */
export function useCloseChecks(options: Options) {
  const [closeChecks] = useState(() => new CloseCheckCoordinator(randomUUID));
  const [closeCheck, setCloseCheck] = useState<CloseCheckRequest | null>(null);
  const current = useRef(options);
  useLayoutEffect(() => {current.current = options;}, [options]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {if (state !== 'active') closeChecks.cancel();});
    return () => {subscription.remove(); closeChecks.cancel();};
  }, [closeChecks]);
  useEffect(() => {closeChecks.cancel();}, [closeChecks, options.identity, options.lifetime, options.blocked]);
  const receiveHostEvent = useCallback((event: HostEvent) => {
    if (event.type === 'ready' && event.generation) closeChecks.ready(event.sessionId, event.generation);
    else if (event.type === 'error') closeChecks.forget(event.sessionId);
    else if (event.type === 'close-check') {closeChecks.receive(event); return;}
    current.current.onHostEvent?.(event);
  }, [closeChecks]);
  const requestClose = async (id: string) => {
    const captured = current.current;
    const session = captured.workspace.current.sessions.find(item => item.id === id);
    if (captured.blocked || closeChecks.isPending() || !session) return;
    const state = await closeChecks.request(id, setCloseCheck);
    setCloseCheck(null);
    const latest = current.current;
    if (state === null || latest.blocked || captured.identity !== latest.identity ||
        !latest.workspace.current.sessions.includes(session) || AppState.currentState !== 'active') return;
    let safe = false;
    try {safe = !latest.pendingApprovals?.has(id) && (latest.canCloseWithoutWarning?.(id) ?? true);}
    catch { /* Unavailable owner evidence retains the warning. */ }
    if (state === 'clean' && safe) latest.onClean(id);
    else latest.onWarning(id);
  };
  return {closeChecks, closeCheck, receiveHostEvent, requestClose};
}
