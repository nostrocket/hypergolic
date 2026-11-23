import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { finishFullscreenSwipe, startFullscreenSwipe } from './fullscreen-swipe';

const revealDuration = 4_000;

interface ExitContext { focusedId: string | null; fullscreen: boolean; blocked: boolean; dragging: boolean }

export function useFullscreenExit({focusedId, fullscreen, blocked, dragging}: ExitContext) {
  const sessionId = fullscreen && !blocked && !dragging ? focusedId : null;
  const {width, height} = useWindowDimensions();
  const {left, right} = useSafeAreaInsets();
  const start = useRef<ReturnType<typeof startFullscreenSwipe>>(null);
  const [edge, setEdge] = useState<ReturnType<typeof finishFullscreenSwipe>>(null);
  const [screenReader, setScreenReader] = useState(false);
  const duration = useRef(revealDuration);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const hide = () => {
      start.current = null;
      clearTimeout(timer.current);
      setEdge(null);
    };
    hide();
    if (!sessionId) return;
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') hide(); });
    return () => { subscription.remove(); clearTimeout(timer.current); };
  }, [sessionId, width, height, left, right]);
  useEffect(() => {
    let current = true;
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', enabled => {
      current = false;
      setScreenReader(enabled);
    });
    void AccessibilityInfo.isScreenReaderEnabled().then(enabled => { if (current) setScreenReader(enabled); }).catch(() => undefined);
    void AccessibilityInfo.getRecommendedTimeoutMillis(revealDuration).then(value => { duration.current = Math.max(revealDuration, value); }).catch(() => undefined);
    return () => { current = false; subscription.remove(); };
  }, []);

  // Observe the native touch stream. A transparent edge Pressable would take game taps.
  const handlers = sessionId && !screenReader ? {
    onTouchStart: ({nativeEvent}: GestureResponderEvent) => {
      start.current = startFullscreenSwipe(nativeEvent, nativeEvent.touches.length, left, width - right);
    },
    onTouchCancel: () => { start.current = null; },
    onTouchEnd: ({nativeEvent}: GestureResponderEvent) => {
      const side = finishFullscreenSwipe(start.current, nativeEvent);
      start.current = null;
      if (!side) return;
      clearTimeout(timer.current);
      setEdge(side);
      timer.current = setTimeout(() => setEdge(null), duration.current);
    },
  } : undefined;
  return {handlers, placement: sessionId ? (screenReader ? 'header' as const : edge) : null};
}
