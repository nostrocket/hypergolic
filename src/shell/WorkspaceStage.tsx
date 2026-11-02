import type { CloseCheckRequest } from './close-check';
import { forwardRef, memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { NappletHost, type HostEvent } from '../runtime/NappletHost';
import { Handles } from './Handles';
import { Overview, type OverviewHandle } from './Overview';
import { cardTransform, clamp, overviewGeometry, resolveCardRect, type HandleSide, type CardMeasurement, type Rect, type Size } from './motion';
import { adjacentNapplet, type NappletDescriptor, type Workspace } from './workspace';
import { useShellStyles, type ShellPalette, type ShellFonts, HANDLE_GUTTER } from './theme';
import { runtimeStatus } from './runtime-status';

interface LiveProps {
  session: NappletDescriptor;
  closeCheck: string;
  index: number;
  size: Size;
  rect: Rect;
  progress: SharedValue<number>;
  position: SharedValue<number>;
  scrollY: SharedValue<number>;
  swipeY: SharedValue<number>;
  swipeId: SharedValue<string | null>;
  active: boolean;
  raised: boolean;
  onHostEvent?: (event: HostEvent) => void;
}
const LiveSession = memo(function LiveSession({ session, closeCheck, index, size, rect, progress, position, scrollY, swipeY, swipeId, active, raised, onHostEvent }: LiveProps) {
  const { styles } = useShellStyles(createStyles);
  // A keyed session starts when first focused and stays mounted until close or identity change.
  const [loaded, setLoaded] = useState(raised);
  if (raised && !loaded) setLoaded(true);
  const [status, setStatus] = useState('Starting runtime');
  const target = cardTransform(size, rect);
  const sessionId = session.id;
  const { x, y, scale } = target;
  const { width, height } = size;
  const movement = useAnimatedStyle(() => {
    const overview = progress.get();
    return { transform: [
      { translateX: (1 - overview) * (index - position.get()) * width + overview * x },
      { translateY: overview * (y - scrollY.get() + (swipeId.get() === sessionId ? swipeY.get() : 0)) },
      { scale: 1 + overview * (scale - 1) },
    ] };
  });
  const onNativeEvent = useCallback(({ nativeEvent }: NativeSyntheticEvent<HostEvent>) => {
    if (nativeEvent.sessionId !== session.id) return;
    if (nativeEvent.type !== 'close-check') setStatus(runtimeStatus(nativeEvent));
    onHostEvent?.(nativeEvent);
  }, [onHostEvent, session.id]);
  return (
    <Animated.View collapsable={false} pointerEvents={active ? 'auto' : 'none'} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!active}
      style={[styles.live, { width, height, zIndex: raised ? 2 : 1 }, movement]}>
      {loaded ? <NappletHost closeCheck={closeCheck} active={active} session={session} onHostEvent={onNativeEvent} style={styles.host} />
        : <View style={styles.unloaded}><Text style={styles.reopen}>Open to load</Text></View>}
      <Text testID={`runtime-status-${session.id}`} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!active} accessibilityLiveRegion={active ? 'polite' : 'none'} style={[styles.runtimeStatus, loaded && status === 'Runtime connected' && styles.connected]}>{loaded ? status : 'Not loaded'}</Text>
    </Animated.View>
  );
});

interface StageProps {
  workspace: Workspace;
  closeCheck: CloseCheckRequest | null;
  progress: SharedValue<number>;
  position: SharedValue<number>;
  scrollY: SharedValue<number>;
  swipeY: SharedValue<number>;
  swipeId: SharedValue<string | null>;
  busy: boolean;
  blocked: boolean;
  interactive: boolean;
  pending: ReadonlySet<string>;
  onHostEvent?: (event: HostEvent) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
  onDragEnd: (id: string, close: boolean) => void;
  onHandleStart: () => void;
  onHandleEnd: (side: HandleSide, result: 'overview' | 'switch' | 'cancel') => void;
}

export const WorkspaceStage = forwardRef<OverviewHandle, StageProps>(function WorkspaceStage({ workspace, closeCheck, progress, position, scrollY, swipeY, swipeId, busy, blocked, interactive, pending, onHostEvent, onFocus, onClose, onOpen, onDragEnd, onHandleStart, onHandleEnd }, ref) {
  const { styles } = useShellStyles(createStyles);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [measured, setMeasured] = useState<Record<string, CardMeasurement>>({});
  const { fontScale } = useWindowDimensions();
  const geometry = useMemo(() => overviewGeometry(size, workspace.sessions.length, fontScale), [fontScale, size, workspace.sessions.length]);
  const disabled = busy || blocked;
  return <View style={styles.stage} testID="shell-stage" onLayout={({ nativeEvent }) => {
    const { width, height } = nativeEvent.layout;
    // A transient zero-sized stage (IME/rotation) must not unmount live sessions.
    if (width <= 0 || height <= 0) return;
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }}>
    {size.width > 0 && size.height > 0 && <>
      {workspace.sessions.map((session, index) => <LiveSession key={session.id} session={session} closeCheck={closeCheck?.sessionId === session.id ? JSON.stringify({id: closeCheck.id, generation: closeCheck.generation}) : ''} index={index} size={size} rect={resolveCardRect(geometry.cards[index], measured[session.id])}
        progress={progress} position={position} scrollY={scrollY} swipeY={swipeY} swipeId={swipeId} active={interactive && !workspace.overview && !disabled && workspace.focusedId === session.id}
        raised={workspace.focusedId === session.id} onHostEvent={onHostEvent} />)}
      <Overview ref={ref} sessions={workspace.sessions} geometry={geometry} size={size} visible={workspace.overview} busy={disabled} focusedId={workspace.focusedId}
        progress={progress} scrollY={scrollY} swipeId={swipeId} swipeY={swipeY} pending={pending} onFocus={onFocus} onClose={onClose} onOpen={onOpen}
        onDragEnd={onDragEnd}
        onMeasure={(id, measurement) => setMeasured(previous => {
          const prior = previous[id];
          return prior && resolveCardRect(measurement.expected, prior) === prior.actual
            && prior.actual.width === measurement.actual.width && prior.actual.height === measurement.actual.height
            ? previous : { ...previous, [id]: measurement };
        })} />
      <Handles width={size.width} position={position} index={Math.max(0, workspace.sessions.findIndex(session => session.id === workspace.focusedId))} count={workspace.sessions.length} top={clamp(size.height * 0.62, 40, Math.max(40, size.height - 104))} disabled={workspace.overview || disabled}
        canPrevious={adjacentNapplet(workspace, -1) !== null} canNext={adjacentNapplet(workspace, 1) !== null}
        onStart={onHandleStart} onEnd={onHandleEnd} />
    </>}
  </View>;
});
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  stage: { flex: 1, marginHorizontal: 6, marginBottom: 2, borderRadius: 0, overflow: 'hidden' },
  live: { position: 'absolute', left: 0, top: 0, overflow: 'hidden', backgroundColor: colors.background },
  host: { flex: 1, marginHorizontal: HANDLE_GUTTER },
  unloaded: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  reopen: { fontFamily: fonts.body, color: colors.muted, fontSize: 22 },
  connected: { position: 'absolute', height: 0, width: 0, paddingVertical: 0, opacity: 0 },
  runtimeStatus: { fontFamily: fonts.body, color: colors.muted, fontSize: 10, textAlign: 'center', paddingVertical: 5, backgroundColor: colors.background },
});
