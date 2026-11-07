import {useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Alert, AppState} from 'react-native';
import type {NappletDescriptor} from './workspace';
import {ZoomResetAction, ZoomResetTargets, type ZoomResetContext} from './zoom-reset';

interface Options extends ZoomResetContext {dragging: boolean; settings: boolean; closing: boolean; reviewing: boolean}
export function useZoomReset(context: Options, dismiss: () => void) {
  const [targets] = useState(() => new ZoomResetTargets());
  useSyncExternalStore(targets.subscribe, targets.getSnapshot, targets.getSnapshot);
  const registerZoomTarget = useCallback((target: Parameters<ZoomResetTargets['register']>[0]) => targets.register(target), [targets]);
  const blocked = context.blocked || context.dragging || context.settings || context.closing || context.reviewing;
  const [action] = useState(() => new ZoomResetAction());
  const current = useRef(context);
  useLayoutEffect(() => {current.current = {...context, blocked};});
  useLayoutEffect(() => {
    action.cancel();
    return () => action.cancel();
  }, [action, context.identity, context.lifetime, context.workspace.focusedId, context.workspace.overview, blocked]);
  useLayoutEffect(() => {
    const observer = AppState.addEventListener('change', state => {if (state !== 'active') action.cancel();});
    return () => {observer.remove(); action.cancel();};
  }, [action]);
  const resetZoom = useCallback((session: NappletDescriptor) => {
    action.request(session, targets.get(session.id), () => ({...current.current, active: AppState.currentState === 'active'}), dismiss,
      run => {const frame = requestAnimationFrame(run); return () => cancelAnimationFrame(frame);},
      () => Alert.alert('Zoom reset not confirmed', 'If the view is still enlarged, return to this napplet and try again.'));
  }, [action, dismiss, targets]);
  return {resetZoom, registerZoomTarget, zoomResetAvailable: targets.get(context.workspace.focusedId ?? '') !== null};
}
