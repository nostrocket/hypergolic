import { FrameCorners } from './FrameCorners';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { Gesture, GestureDetector, type NativeGesture, type GestureTouchEvent, type GestureStateManager } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { clamp, shouldCloseCard, wantsCardClose, type Drag, type Rect, type CardMeasurement } from './motion';
import type { NappletDescriptor } from './workspace';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { cardDragFromTouch, releasedCardTouch, isCardTapRelease, type CardTouchOrigin, type CardTouchPoint } from './cardTouch';

interface Props {
  session: NappletDescriptor;
  rect: Rect;
  captionHeight: number;
  busy: boolean;
  selected: boolean;
  pending: boolean;
  swipeId: SharedValue<string | null>;
  swipeY: SharedValue<number>;
  scrollGesture: NativeGesture;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onDragEnd: (id: string, close: boolean) => void;
  onMeasure: (id: string, measurement: CardMeasurement) => void;
  setRef: (id: string, view: View | null) => void;
}

export function OverviewCard({ session, rect, captionHeight, busy, selected, pending, swipeId, swipeY, scrollGesture, onFocus, onClose, onDragEnd, onMeasure, setRef }: Props) {
  const { styles } = useShellStyles(createStyles);
  const { id, title } = session;
  const tapOrigin = useSharedValue<CardTouchPoint | null>(null);
  const tapAccepted = useSharedValue(false);
  const tapCancelled = useSharedValue(false);
  const dragging = useSharedValue(false);
  const cancelled = useSharedValue(false);
  const finalized = useSharedValue(true);
  const releaseAccepted = useSharedValue(false);
  const origin = useSharedValue<CardTouchOrigin | null>(null);
  const travel = useSharedValue<Drag>({ dx: 0, dy: 0, vx: 0, vy: 0, touches: 1 });
  const cancel = useCallback((manager: GestureStateManager) => {
    'worklet';
    cancelled.set(true); releaseAccepted.set(false);
    // End an active manual recognizer through its supported API; finalized rejects
    // this cancelled sequence. Pending recognizers simply fail, releasing scrolling.
    if (dragging.get()) manager.end(); else manager.fail();
  }, [cancelled, dragging, releaseAccepted]);
  const move = useCallback((event: GestureTouchEvent, manager: GestureStateManager) => {
    'worklet';
    const touch = event.allTouches.length === 1 ? event.allTouches[0] : undefined;
    const now = Date.now();
    const drag = cardDragFromTouch(origin.get(), touch, now, event.numberOfTouches);
    if (!drag || cancelled.get()) { cancel(manager); return; }
    travel.set(drag);
    if (dragging.get()) swipeY.set(clamp(drag.dy, -160, 0));
    else if (wantsCardClose(drag)) manager.activate();
    else if (Math.max(Math.abs(drag.dx), Math.abs(drag.dy)) > 12) manager.fail();
  }, [cancel, cancelled, dragging, origin, swipeY, travel]);
  const down = useCallback((event: GestureTouchEvent, manager: GestureStateManager) => {
    'worklet';
    const touch = event.allTouches.length === 1 ? event.allTouches[0] : undefined;
    if (origin.get() !== null || event.numberOfTouches !== 1 || !touch) { cancel(manager); return; }
    origin.set({ id: touch.id, x: touch.absoluteX, y: touch.absoluteY, time: Date.now() });
    dragging.set(false); cancelled.set(false); finalized.set(false); releaseAccepted.set(false);
    travel.set({ dx: 0, dy: 0, vx: 0, vy: 0, touches: 1 });
  }, [cancel, cancelled, dragging, finalized, origin, releaseAccepted, travel]);
  const up = useCallback((event: GestureTouchEvent, manager: GestureStateManager) => {
    'worklet';
    const drag = releasedCardTouch(origin.get(), event.changedTouches, event.numberOfTouches, Date.now(), cancelled.get());
    // Manual events have no native pan velocity. Both admission and the short
    // release criterion use travel / elapsed time from the original touch.
    releaseAccepted.set(dragging.get() && drag !== null && shouldCloseCard(drag));
    if (drag) travel.set(drag);
    if (dragging.get()) manager.end(); else manager.fail();
  }, [cancelled, dragging, origin, releaseAccepted, travel]);
  const pan = Gesture.Manual().enabled(!busy)
    .blocksExternalGesture(scrollGesture).shouldCancelWhenOutside(false)
    .onTouchesDown(down)
    .onTouchesMove(move)
    .onStart(() => {
      dragging.set(true); swipeId.set(id); swipeY.set(clamp(travel.get().dy, -160, 0));
    })
    .onTouchesUp(up)
    .onTouchesCancelled(() => {
      cancelled.set(true); releaseAccepted.set(false);
    })
    .onFinalize((_event, success) => {
      if (finalized.get()) return;
      finalized.set(true);
      const wasDragging = dragging.get();
      const close = success && wasDragging && !cancelled.get() && releaseAccepted.get();
      dragging.set(false); origin.set(null); releaseAccepted.set(false);
      if (wasDragging) scheduleOnRN(onDragEnd, id, close);
    });
  const tap = Gesture.Tap().enabled(!busy).maxDistance(8).requireExternalGestureToFail(pan)
    .onTouchesDown((event, manager) => {
      const point = event.allTouches.length === 1 ? event.allTouches[0] : undefined;
      if (tapOrigin.get() !== null || event.numberOfTouches !== 1 || !point) {
        tapCancelled.set(true); tapAccepted.set(false); manager.fail(); return;
      }
      tapOrigin.set({ id: point.id, absoluteX: point.absoluteX, absoluteY: point.absoluteY });
      tapCancelled.set(false); tapAccepted.set(false);
    })
    .onTouchesUp((event, manager) => {
      tapAccepted.set(!tapCancelled.get() && isCardTapRelease(tapOrigin.get(), event.changedTouches, event.numberOfTouches));
      if (!tapAccepted.get()) manager.fail();
    })
    .onTouchesCancelled(() => { tapCancelled.set(true); tapAccepted.set(false); })
    .onEnd((_event, success) => { if (success && tapAccepted.get() && !tapCancelled.get()) scheduleOnRN(onFocus, id); })
    .onFinalize(() => { tapOrigin.set(null); tapAccepted.set(false); });
  const movement = useAnimatedStyle(() => ({ transform: [{ translateY: swipeId.get() === id ? swipeY.get() : 0 }] }));
  return <GestureDetector gesture={pan}>
    <Animated.View
      style={[styles.card, { width: rect.width, height: rect.height + captionHeight }, movement]}>
      <GestureDetector gesture={tap}><View accessible focusable accessibilityState={{ disabled: busy }} onLayout={({ nativeEvent }) => onMeasure(id, { expected: rect, actual: { ...rect, width: nativeEvent.layout.width, height: nativeEvent.layout.height } })} ref={view => setRef(id, view)} testID={`overview-card-${id}`} accessibilityRole="button" accessibilityLabel={`Open ${title}`}
        accessibilityHint="Opens this napplet. Swipe quickly upward to close it."
        accessibilityActions={[{ name: 'activate', label: `Open ${title}` }, { name: 'close', label: `Close ${title}` }]}
        onAccessibilityTap={() => { if (!busy) onFocus(id); }}
        onAccessibilityAction={({ nativeEvent }) => {
          if (busy) return;
          if (nativeEvent.actionName === 'close') onClose(id);
          else if (nativeEvent.actionName === 'activate') onFocus(id);
        }}
        style={[styles.previewTarget, { height: rect.height }, selected && styles.selected]}><FrameCorners /></View></GestureDetector>
      <View style={[styles.caption, { height: captionHeight }]}>
        <View style={styles.label} pointerEvents="none">
          <Text numberOfLines={1} style={styles.cardTitle}>{title}</Text>
          {pending && <Text style={styles.pending}>Approval waiting</Text>}
        </View>
        <Pressable testID={`overview-close-${id}`} accessibilityRole="button" accessibilityLabel={`Close ${title}`} onPress={() => onClose(id)} disabled={busy} style={styles.close}>
          <Text style={styles.closeMark} accessible={false}>×</Text>
        </Pressable>
      </View>
    </Animated.View>
  </GestureDetector>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  card: { marginBottom: 20 },
  previewTarget: { width: '100%', borderRadius: 0, borderWidth: 1, borderColor: colors.border },
  selected: { borderWidth: 1, borderColor: colors.text },
  caption: { flexDirection: 'row', alignItems: 'center', paddingLeft: 2 },
  label: { flex: 1 }, cardTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.text },
  pending: { fontFamily: fonts.body, color: colors.accent, fontSize: 11, marginTop: 2 },
  close: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeMark: { fontFamily: fonts.body, fontSize: 25, color: colors.muted },
});
