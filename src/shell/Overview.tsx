import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { AccessibilityInfo, FlatList, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { OverviewCard } from './OverviewCard';
import type { OverviewGeometry, CardMeasurement, Size } from './motion';
import type { NappletDescriptor } from './workspace';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

export interface OverviewHandle { focusCard: (id: string | null) => void; revealCard: (id: string | null) => void }
interface Props {
  sessions: readonly NappletDescriptor[];
  geometry: OverviewGeometry;
  size: Size;
  visible: boolean;
  busy: boolean;
  focusedId: string | null;
  progress: SharedValue<number>;
  scrollY: SharedValue<number>;
  swipeId: SharedValue<string | null>;
  swipeY: SharedValue<number>;
  pending: ReadonlySet<string>;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
  onDragEnd: (id: string, close: boolean) => void;
  onMeasure: (id: string, measurement: CardMeasurement) => void;
}
function focusView(view: View | Text | null | undefined) {
  if (!view) return;
  view.focus();
  AccessibilityInfo.sendAccessibilityEvent(view, 'focus');
}
const sessionKey = (session: NappletDescriptor): string => session.id;

/** Only transparent controls virtualize; the live native views stay in WorkspaceStage. */
export const Overview = forwardRef<OverviewHandle, Props>(function Overview({ sessions, geometry, size, visible, busy, focusedId, progress, scrollY, swipeId, swipeY, pending, onFocus, onClose, onOpen, onDragEnd, onMeasure }, ref) {
  const { styles } = useShellStyles(createStyles);
  const scroll = useRef<FlatList<NappletDescriptor>>(null);
  const heading = useRef<Text>(null);
  const cardRefs = useRef(new Map<string, View>());
  const scrollGesture = useMemo(() => Gesture.Native(), []);
  const setCardRef = useCallback((id: string, view: View | null) => {
    if (view) cardRefs.current.set(id, view); else cardRefs.current.delete(id);
  }, []);
  useImperativeHandle(ref, () => ({
    focusCard: id => focusView(id ? cardRefs.current.get(id) ?? heading.current : heading.current),
    revealCard: id => {
      const index = sessions.findIndex(session => session.id === id);
      const rect = geometry.cards[index];
      if (!rect) return;
      const top = scrollY.get();
      const bottom = rect.y + rect.height + geometry.captionHeight;
      const next = rect.y < top ? Math.max(0, rect.y - 12) : bottom > top + size.height ? bottom - size.height + 12 : top;
      scroll.current?.scrollToOffset({ offset: next, animated: false });
      scrollY.set(next);
    },
  }), [geometry, scrollY, sessions, size.height]);
  const opacity = useAnimatedStyle(() => ({ opacity: progress.get() }));
  const onScroll = useAnimatedScrollHandler(event => { scrollY.set(event.contentOffset.y); });
  const headerHeight = geometry.cards[0]?.y ?? 72;
  const cardHeight = geometry.cards[0]?.height ?? 0;
  const stride = cardHeight + geometry.captionHeight + 20;
  const renderCard = useCallback(({ item, index }: { item: NappletDescriptor; index: number }) => (
    <OverviewCard session={item} rect={geometry.cards[index]} captionHeight={geometry.captionHeight}
      busy={busy} selected={focusedId === item.id} pending={pending.has(item.id)} swipeId={swipeId} swipeY={swipeY} scrollGesture={scrollGesture}
      setRef={setCardRef} onFocus={onFocus} onClose={onClose} onDragEnd={onDragEnd} onMeasure={onMeasure} />
  ), [busy, focusedId, geometry, onClose, onDragEnd, onFocus, onMeasure, pending, scrollGesture, setCardRef, swipeId, swipeY]);
  return <Animated.View style={[StyleSheet.absoluteFill, styles.layer, opacity]} pointerEvents={visible && !busy ? 'auto' : 'none'} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>
    <GestureDetector gesture={scrollGesture}>
      <Animated.FlatList ref={scroll} data={sessions} numColumns={2} keyExtractor={sessionKey} testID="napplet-overview"
        initialNumToRender={6} windowSize={5} removeClippedSubviews={false} scrollEnabled={visible && !busy}
        onScroll={onScroll} scrollEventThrottle={16} bounces={false} overScrollMode="never" keyboardShouldPersistTaps="handled"
        columnWrapperStyle={styles.row} contentContainerStyle={{ minHeight: geometry.contentHeight, paddingHorizontal: 12, paddingBottom: 24 }}
        getItemLayout={(_data, row) => ({ index: row, length: stride, offset: headerHeight + row * stride })}
        ListHeaderComponent={sessions.length > 0 ? <View style={[styles.headingRow, { height: headerHeight }]}>
          <Text ref={heading} accessibilityRole="header" style={styles.heading}>Your napplets</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Open napplet" testID="overview-open" onPress={onOpen} style={styles.open}><Text style={styles.openText}>+ Open</Text></Pressable>
        </View> : null}
        ListEmptyComponent={<View style={[styles.empty, { paddingTop: Math.min(size.height * 0.42, 260) }]}><Text style={styles.emptyLabel}>Your space</Text>
          <Text accessibilityRole="header" style={styles.emptyTitle}>A place for{'\n'}your napplets.</Text>
          <Text style={styles.emptyDetail}>Open a Nostr app with its address. Your identity stays with Hypergolic.</Text>
          <Pressable accessibilityRole="button" testID="empty-open-napplet" onPress={onOpen} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Open napplet</Text></Pressable>
        </View>}
        renderItem={renderCard} />
    </GestureDetector>
  </Animated.View>;
});
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  layer: { zIndex: 10 }, row: { gap: 16 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  heading: { fontFamily: fonts.strong, fontSize: 19, color: colors.text, flexShrink: 1 },
  open: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  openText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.accent, fontSize: 14, },
  empty: { padding: 12, paddingBottom: 36, gap: 20 },
  emptyTitle: { fontFamily: fonts.display, color: colors.text, fontSize: 46, lineHeight: 48 },
  emptyLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: colors.accent },
  emptyDetail: { fontFamily: fonts.body, fontSize: 17, lineHeight: 25, color: colors.muted, maxWidth: 340 },
  emptyButton: { minHeight: 56, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 14, marginTop: 12 },
  emptyButtonText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14 },
});
