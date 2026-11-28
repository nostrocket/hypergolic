import {requireNativeView} from 'expo';
import {useState, type ReactNode} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, View, type NativeSyntheticEvent, type ViewProps} from 'react-native';

type BoundaryProps = ViewProps & {onOverlapChange(event: NativeSyntheticEvent<{bottom: number}>): void};
const AndroidBoundary = Platform.OS === 'android'
  ? requireNativeView<BoundaryProps>('HypergolicNappletHost', 'KeyboardBoundary') : null;

/** Android Settings opens in a separate dialog, which owns its IME insets. */
export function SettingsKeyboardViewport({children}: {children: ReactNode}) {
  const [overlap, setOverlap] = useState(0);
  if (!AndroidBoundary) return <KeyboardAvoidingView behavior="padding" style={styles.viewport}>{children}</KeyboardAvoidingView>;
  return <View style={styles.viewport}>
    <View style={[styles.viewport, {marginBottom: overlap}]}>{children}</View>
    <AndroidBoundary accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.boundary}
      onOverlapChange={event => setOverlap(event.nativeEvent.bottom)} />
  </View>;
}

const styles = StyleSheet.create({
  viewport: {flex: 1},
  boundary: {position: 'absolute', bottom: 0, left: 0, height: 1, width: 1},
});
