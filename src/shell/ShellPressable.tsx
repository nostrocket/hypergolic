import { useShellStyles, type ShellPalette } from './theme';
import { forwardRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, type PressableProps, type ViewInstance } from 'react-native';

/** Shared native feedback also covers disabled controls and keyboard focus. */
export const ShellPressable = forwardRef<ViewInstance, PressableProps & { dimOnPress?: boolean }>(function ShellPressable({ dimOnPress = true, style, disabled, accessibilityState, onFocus, onBlur, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  const { styles } = useShellStyles(createStyles);
  return <Pressable {...props} ref={ref} disabled={disabled} accessibilityState={{ ...accessibilityState, disabled: disabled ?? accessibilityState?.disabled }}
    onFocus={event => { setFocused(true); onFocus?.(event); }} onBlur={event => { setFocused(false); onBlur?.(event); }}
    style={state => [styles.target, typeof style === 'function' ? style(state) : style, dimOnPress && state.pressed && styles.pressed, focused && styles.focused, disabled && styles.disabled]} />;
});
const minimumTarget = Platform.OS === 'android' ? 48 : 44;
const createStyles = (colors: ShellPalette) => StyleSheet.create({
  focused: { outlineColor: colors.accent, outlineWidth: 2, outlineOffset: 2 },
  target: { minHeight: minimumTarget, minWidth: minimumTarget },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
