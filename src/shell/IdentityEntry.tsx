import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ShellPressable } from './ShellPressable';
import { getIdentityState, retryIdentityRead, startIdentity, subscribeIdentity } from '../security/identity-state';
import { ShellBackdrop } from './ShellBackdrop';
import { IdentityShell } from './IdentityShell';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

const unavailableMessages = {
  'read-unavailable': {
    heading: 'Identity storage is unavailable',
    detail: 'Unlock your device, then try opening your identity again.',
  },
  'restart-required': {
    heading: 'Restart Hypergolic',
    detail: 'Close the app completely, then open it again to continue.',
  },
  'recovery-required': {
    heading: 'Your identity needs attention',
    detail: 'Your saved identity could not be opened. Restart the app to try again. Hypergolic has not replaced your identity.',
  },
  'workspace-required': {
    heading: 'Your workspace needs attention',
    detail: 'Your saved workspace could not be opened. Restart the app to try again. Hypergolic has kept your saved data.',
  },
  'device-required': {
    heading: 'Use a physical iPhone',
    detail: 'Simulator cannot provide the file protection required for identity storage. Open Hypergolic on an iPhone to continue.',
  },
} as const;

function OpeningScreen() {
  const { styles, colors, isDark } = useShellStyles(createStyles, true);
  const [showStatus, setShowStatus] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowStatus(true), 500);
    return () => clearTimeout(timer);
  }, []);
  return <SafeAreaView style={styles.screen}>
    <ShellBackdrop mood="home" /><StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
    {showStatus && <View style={styles.progress} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.accent} accessible={false} />
      <Text style={styles.progressLabel}>Opening your identity…</Text>
    </View>}
  </SafeAreaView>;
}

export function IdentityEntry() {
  const { styles, isDark } = useShellStyles(createStyles);
  const state = useSyncExternalStore(subscribeIdentity, getIdentityState);
  useEffect(() => { startIdentity(); }, []);
  if (state.status === 'ready') return <IdentityShell owner={state.owner} />;
  if (state.status === 'opening') return <OpeningScreen />;
  const message = unavailableMessages[state.status];
  return <SafeAreaView style={styles.screen}>
    <ShellBackdrop mood="failed" /><StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
    <View style={styles.brand}>
      <Image source={require('../../assets/brand/hypergolic-logo.png')} style={styles.logo} contentFit="contain" accessible={false} />
      <Text style={styles.name}>Hypergolic</Text>
    </View>
    <ScrollView contentContainerStyle={styles.message} testID="identity-entry-status" accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" style={styles.heading}>{message.heading}</Text>
      <Text style={styles.detail}>{message.detail}</Text>
      {state.status === 'read-unavailable' && <ShellPressable accessibilityRole="button" onPress={retryIdentityRead}>
        <Text style={styles.retry}>Try again</Text>
      </ShellPressable>}
    </ScrollView>
  </SafeAreaView>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  progress: { alignSelf: 'center', alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: colors.surface },
  progressLabel: { fontFamily: fonts.body, color: colors.text, fontSize: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, paddingHorizontal: 20 },
  logo: { width: 32, height: 32 },
  name: { fontFamily: fonts.medium, color: colors.text, fontSize: 15, letterSpacing: 3, textTransform: 'uppercase' },
  message: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 120, paddingHorizontal: 24, paddingBottom: 64, gap: 18 },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 40, lineHeight: 44 },
  retry: { fontFamily: fonts.medium, color: colors.accent, fontSize: 18, paddingVertical: 12 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
});
