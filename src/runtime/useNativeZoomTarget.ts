import {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {AppState, Platform} from 'react-native';
import {createZoomResetTarget, NativeZoomRequests, type NativeZoomView, type ZoomResetRegistration} from '../shell/zoom-reset';

/** View refs and native readiness stay local to this keyed component lifetime. */
export function useNativeZoomTarget(sessionId: string, active: boolean, register?: ZoomResetRegistration) {
  const view = useRef<NativeZoomView | null>(null), generation = useRef<string | null>(null);
  const instance = useRef<object | null>(null);
  const mounted = useRef(true), interactive = useRef(active), unregister = useRef<(() => void) | null>(null);
  const [zoomReset, setZoomReset] = useState('');
  const [requests] = useState(() => new NativeZoomRequests(setZoomReset));
  useLayoutEffect(() => {interactive.current = active; if (!active) requests.cancel();}, [active, requests]);
  const publish = useCallback(() => {
    unregister.current?.(); unregister.current = null;
    if (Platform.OS !== 'ios' || !mounted.current || !view.current || !generation.current || !register) return;
    const target = createZoomResetTarget(sessionId, generation.current, view.current, () => ({
      view: view.current, generation: generation.current,
      available: mounted.current && interactive.current && AppState.currentState === 'active',
    }));
    unregister.current = register(target);
  }, [register, sessionId]);
  const clearZoomTarget = useCallback(() => {requests.cancel(); generation.current = null; publish();}, [publish, requests]);
  const zoomRef = useCallback((next: object | null) => {
    if (instance.current === next) return;
    requests.cancel(); instance.current = next;
    view.current = next ? {resetZoom: (session, ready) => requests.request(session, ready)} : null;
    generation.current = null;
    publish();
  }, [publish, requests]);
  const zoomReady = useCallback((value: string) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) return;
    generation.current = value; publish();
  }, [publish]);
  useLayoutEffect(() => {
    mounted.current = true; publish();
    return () => {mounted.current = false; requests.cancel(false); unregister.current?.(); unregister.current = null;};
  }, [publish, requests]);
  useLayoutEffect(() => {
    const observer = AppState.addEventListener('change', state => {if (state !== 'active') requests.cancel();});
    return () => observer.remove();
  }, [requests]);
  const zoomReply = useCallback((message: {type: string}) => {
    if (message.type !== 'zoom-reset') return false;
    requests.receive(message); return true;
  }, [requests]);
  const zoomNativeProps: {zoomReset?: string} = Platform.OS === 'ios' ? {zoomReset} : {};
  return {zoomRef, zoomReady, clearZoomTarget, zoomReply, zoomNativeProps};
}
