import { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getIdentityState, startIdentity, subscribeIdentity } from '../security/identity-state';
import { ShellBackdrop } from './ShellBackdrop';
import { IdentityShell } from './IdentityShell';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

const unavailableMessages = {
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

export function IdentityEntry() {
  const { styles, colors, isDark } = useShellStyles(createStyles);
  const state = useSyncExternalStore(subscribeIdentity, getIdentityState);
  useEffect(() => { startIdentity(); }, []);
  if (state.status === 'ready') return <IdentityShell owner={state.owner} />;
  const message = state.status === 'opening' ? null : unavailableMessages[state.status];
  return <SafeAreaView style={styles.screen}>
    <ShellBackdrop mood={message ? "failed" : "entry"} /><StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
    <View style={styles.brand}>
      <Image source={require('../../assets/brand/hypergolic-logo.png')} style={styles.logo} contentFit="contain" accessible={false} />
      <Text style={styles.name}>Hypergolic</Text>
    </View>
    <ScrollView contentContainerStyle={styles.message} testID="identity-entry-status" accessibilityLiveRegion="polite">
      {message === null ? <><ActivityIndicator color={colors.accent} accessibilityLabel="Opening your identity" /><Text style={styles.detail}>Opening your identity…</Text></>
        : <><Text accessibilityRole="header" style={styles.heading}>{message.heading}</Text>
          <Text style={styles.detail}>{message.detail}</Text></>}
    </ScrollView>
  </SafeAreaView>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, paddingHorizontal: 20 },
  logo: { width: 32, height: 32 },
  name: { fontFamily: fonts.medium, color: colors.text, fontSize: 15, letterSpacing: 3, textTransform: 'uppercase' },
  message: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 120, paddingHorizontal: 24, paddingBottom: 64, gap: 18 },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 40, lineHeight: 44 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
});
