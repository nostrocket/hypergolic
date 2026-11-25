import { useRef } from 'react';
import { StyleSheet, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';
import { useReducedMotion } from './useReducedMotion';

type Props = {
  label: string;
  onPress(): void;
  testID?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

const engage = { duration: 105, easing: Easing.out(Easing.cubic) };
const release = { duration: 180, easing: Easing.out(Easing.cubic) };

export function ThumbAction({ label, onPress, testID, accessibilityLabel = label, disabled, style }: Props) {
  const { styles, colors } = useShellStyles(createStyles);
  const reduced = useReducedMotion();
  const width = useRef(1);
  const depth = useSharedValue(0);
  const drift = useSharedValue(0);
  function track(event: GestureResponderEvent) {
    const x = Math.max(-1, Math.min(1, 2 * event.nativeEvent.locationX / width.current - 1));
    drift.set(withTiming(x * 4, engage));
  }
  const surface = useAnimatedStyle(() => ({
    transform: [{ translateY: reduced ? 0 : -2 * depth.get() }],
  }));
  const type = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced ? 0 : drift.get() * depth.get() }, { scale: reduced ? 1 : 1 + 0.045 * depth.get() }],
  }));
  return <ShellPressable dimOnPress={false} testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    disabled={disabled} style={style} onPress={onPress} onLayout={e => { width.current = Math.max(1, e.nativeEvent.layout.width); }}
    onPressIn={e => { track(e); depth.set(withTiming(1, engage)); }} onPressMove={track}
    onPressOut={() => { depth.set(withTiming(0, release)); }}>
    {({ pressed }) => <Animated.View pointerEvents="none" style={[styles.face, surface, pressed && !reduced && styles.lift, { borderColor: pressed ? colors.accent : colors.primary }]}>
      <Animated.Text style={[styles.label, type]}>{label}</Animated.Text>
    </Animated.View>}
  </ShellPressable>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  lift: { boxShadow: '0 3px 4px rgba(0,0,0,0.24)' },
  face: { flexGrow: 1, minHeight: 50, minWidth: 48, paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.onPrimary, fontFamily: fonts.strong, fontSize: 16, textAlign: 'center' },
});
