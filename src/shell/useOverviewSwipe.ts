import {useLayoutEffect, useRef} from 'react';
import {AppState} from 'react-native';
import {useSharedValue, type SharedValue} from 'react-native-reanimated';
import {homeVisible} from './pins';
import type {NappletDescriptor, Workspace} from './workspace';

type Animate = (value: SharedValue<number>, destination: number, done: () => void, duration: number) => void;

export function useOverviewSwipe(workspace: Workspace, blocked: boolean, scrollY: SharedValue<number>, animate: Animate, close: (id: string) => void) {
  const swipeId = useSharedValue<string | null>(null);
  const swipeY = useSharedValue(0);
  const dismissing = useRef<NappletDescriptor | null>(null);
  const available = !blocked && workspace.overview && !homeVisible(workspace);
  useLayoutEffect(() => {
    // Keep the outgoing preview offscreen until React has removed its session.
    const session = dismissing.current;
    if (!available || (session && !workspace.sessions.includes(session))) {
      dismissing.current = null;
      swipeId.set(null);
    }
  }, [available, swipeId, workspace.sessions]);

  function onDragEnd(id: string, cardBottom: number | null) {
    if (swipeId.get() !== id) return;
    const session = workspace.sessions.find(item => item.id === id);
    if (!available || !session || cardBottom === null) {
      animate(swipeY, 0, () => swipeId.set(null), 140);
      return;
    }
    dismissing.current = session;
    const offscreen = Math.min(swipeY.get(), scrollY.get() - cardBottom);
    animate(swipeY, offscreen, () => {
      if (dismissing.current !== session) return;
      if (AppState.currentState === 'active') close(id);
      else {
        dismissing.current = null;
        swipeId.set(null);
      }
    }, 160);
  }
  return {swipeId, swipeY, onDragEnd};
}
