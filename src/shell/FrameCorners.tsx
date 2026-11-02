import { StyleSheet, View } from 'react-native';
import { useShellStyles, type ShellPalette } from './theme';

export function FrameCorners() {
  const { styles } = useShellStyles(createStyles);
  return <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
    <View style={[styles.corner, styles.topLeft]} /><View style={[styles.corner, styles.topRight]} />
    <View style={[styles.corner, styles.bottomLeft]} /><View style={[styles.corner, styles.bottomRight]} />
  </View>;
}
const createStyles = (colors: ShellPalette) => StyleSheet.create({
  corner: { position: 'absolute', width: 12, height: 12, borderColor: colors.text },
  topLeft: { left: 0, top: 0, borderLeftWidth: 1, borderTopWidth: 1 },
  topRight: { right: 0, top: 0, borderRightWidth: 1, borderTopWidth: 1 },
  bottomLeft: { left: 0, bottom: 0, borderLeftWidth: 1, borderBottomWidth: 1 },
  bottomRight: { right: 0, bottom: 0, borderRightWidth: 1, borderBottomWidth: 1 },
});
