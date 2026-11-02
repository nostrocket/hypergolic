import { useShellStyles, type ShellPalette } from './theme';
import { forwardRef, useState } from 'react';
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

/** Shared native feedback also covers disabled controls and keyboard focus. */
export const ShellPressable = forwardRef<View, PressableProps>(function ShellPressable({ style, disabled, accessibilityState, onFocus, onBlur, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  const { styles } = useShellStyles(createStyles);
  return <Pressable {...props} ref={ref} disabled={disabled} accessibilityState={{ ...accessibilityState, disabled: disabled ?? accessibilityState?.disabled }}
    onFocus={event => { setFocused(true); onFocus?.(event); }} onBlur={event => { setFocused(false); onBlur?.(event); }}
    style={state => [styles.target, typeof style === 'function' ? style(state) : style, state.pressed && styles.pressed, focused && styles.focused, disabled && styles.disabled]} />;
});
const createStyles = (colors: ShellPalette) => StyleSheet.create({
  focused: { outlineColor: colors.accent, outlineWidth: 2, outlineOffset: 2 },
  target: { minHeight: 44, minWidth: 44 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
