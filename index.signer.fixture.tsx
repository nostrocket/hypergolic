import { useState } from 'react';
import { registerRootComponent } from 'expo';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { claimIdentityOwner } from './src/security/native-identity-owner';
import { NativeSignerCheck } from './src/shell/NativeSignerCheck';
import { NativeBoundaryCheck } from './tests/native/securestore-config/NativeBoundaryCheck';
import { ShellPressable } from './src/shell/ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './src/shell/theme';

// Dedicated disposable app entry. It claims the real native context without opening saved-key storage.
const claimed = claimIdentityOwner();

function SignerFixture() {
  const { styles } = useShellStyles(createStyles);
  const [showing, setShowing] = useState(true);
  return <SafeAreaProvider><SafeAreaView style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>Native signer bridge check</Text>
      <Text testID="signer-fixture-owner" style={styles.detail}>{claimed ? 'Native owner claimed. No saved identity storage is opened.' : 'Native owner denied.'}</Text>
      {claimed && showing && <NativeSignerCheck />}
      {claimed && <ShellPressable accessibilityRole="button" testID="signer-fixture-toggle" onPress={() => setShowing(value => !value)} style={styles.action}>
        <Text style={styles.detail}>{showing ? 'Close signer check' : 'Open signer check'}</Text>
      </ShellPressable>}
      {claimed && <NativeBoundaryCheck />}
    </ScrollView>
  </SafeAreaView></SafeAreaProvider>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 20 },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 28 },
  detail: { fontFamily: fonts.body, color: colors.text, fontSize: 16, lineHeight: 24 },
  action: { borderWidth: 1, borderColor: colors.border, minHeight: 56, padding: 16 },
});

registerRootComponent(SignerFixture);
