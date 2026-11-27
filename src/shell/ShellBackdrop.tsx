import launchSky from '../../assets/shell/launch-sky.json';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { useShellStyles, type ShellPalette } from './theme';

type Mood = 'home' | 'shelf' | 'running' | 'quiet' | 'failed';
const artwork = {
  dark: { launch: require('../../assets/shell/launch-night.jpg'), sky: require('../../assets/shell/sky-dark.png'), planet: require('../../assets/shell/planet-dark.png'), beam: require('../../assets/shell/beam-dark.png'), flare: require('../../assets/shell/flare-dark.png') },
  light: { launch: require('../../assets/shell/launch-morning.jpg'), sky: require('../../assets/shell/sky-light.png'), planet: require('../../assets/shell/planet-light.png'), beam: require('../../assets/shell/beam-light.png'), flare: require('../../assets/shell/flare-light.png') },
};

/** Keep the real launch site and the end of its ignition trail inside short headers. */
export function LaunchHorizon() {
  const { styles, isDark } = useShellStyles(createStyles);
  return <Image source={artwork[isDark ? 'dark' : 'light'].launch} style={styles.launchHorizon}
    contentFit="cover" contentPosition="bottom" transition={0} accessible={false} />;
}

export function WorkspaceBackdrop({ home, overview }: { home: boolean; overview: boolean }) {
  return <ShellBackdrop mood={home ? 'home' : overview ? 'shelf' : 'running'} />;
}

/** Static light carries the visual identity without motion, blur or guest compositing. */
export function ShellBackdrop({ mood = 'shelf' }: { mood?: Mood }) {
  const { styles, isDark } = useShellStyles(createStyles);
  const source = artwork[isDark ? 'dark' : 'light'];
  if (mood === 'home') return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.backdrop, { backgroundColor: isDark ? launchSky.night : launchSky.morning }]}>
    <Image source={source.launch} style={StyleSheet.absoluteFill} contentFit="fill" transition={0} accessible={false} />
  </View>;
  const planet = mood !== 'running' && mood !== 'quiet';
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.backdrop}>
    {mood !== 'running' && <Image source={source.sky} style={StyleSheet.absoluteFill} contentFit="fill" />}
    {planet && <Image source={source.planet} style={[styles.planet, styles.horizon]} contentFit="fill" />}
    {mood !== 'quiet' && mood !== 'failed' && mood !== 'running' && <Image source={source.beam} style={styles.beam} contentFit="fill" />}
    {planet && mood !== 'failed' && <Image source={source.flare} style={[styles.flare, styles.horizon]} contentFit="fill" />}
    {mood === 'failed' && <View style={[styles.failed, styles.horizon]} />}
  </View>;
}

const createStyles = (colors: ShellPalette) => StyleSheet.create({
  launchHorizon: { width: '100%', height: 84, backgroundColor: colors.surface },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden', backgroundColor: colors.background },
  horizon: { top: '30%' },
  planet: { position: 'absolute', left: '-60%', width: '220%', aspectRatio: 1 },
  beam: { position: 'absolute', left: '50%', marginLeft: -20, width: 40, height: '100%', top: 0 },
  flare: { position: 'absolute', left: '20%', width: '60%', height: 48, marginTop: -24 },
  failed: { position: 'absolute', left: '50%', marginLeft: -3, width: 6, height: 6, backgroundColor: colors.accent },
});
