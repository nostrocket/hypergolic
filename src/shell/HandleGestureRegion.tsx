import { requireNativeView } from 'expo';
import { Platform, StyleSheet, type ViewProps } from 'react-native';

const NativeRegion = Platform.OS === 'android'
  ? requireNativeView<ViewProps & { active: boolean }>('HypergolicNappletHost', 'ShellGestureRegion')
  : null;

/** Android Back stays available everywhere outside these small native regions. */
export function HandleGestureRegion({ active }: { active: boolean }) {
  return NativeRegion && <NativeRegion active={active} style={StyleSheet.absoluteFill} pointerEvents="none"
    accessible={false} importantForAccessibility="no-hide-descendants" />;
}
