import { forwardRef, useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { useShellStyles, type ShellPalette } from './theme';

export const ShellTextInput = forwardRef<TextInput, TextInputProps>(function ShellTextInput({ style, onFocus, onBlur, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  const { colors, styles } = useShellStyles(createStyles);
  return <TextInput {...props} ref={ref} selectionColor={colors.accent}
    style={[style, focused && styles.focused]}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }} />;
});
const createStyles = (colors: ShellPalette) => StyleSheet.create({ focused: { borderColor: colors.accent, borderWidth: 1 } });
