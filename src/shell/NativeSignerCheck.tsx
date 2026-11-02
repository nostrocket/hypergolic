import { useEffect, useRef, useState } from 'react';
import { requireOptionalNativeModule } from 'expo';
import { StyleSheet, Text, View } from 'react-native';
import { runNativeSignerCheck, type NativeSignerCoreModule } from '../security/native-signer-core';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

const signer = requireOptionalNativeModule<NativeSignerCoreModule>('HypergolicSignerCore');

export function NativeSignerCheck() {
  const { styles } = useShellStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void signer?.cancelDisposableReviewAsync().catch(() => {});
    };
  }, []);
  async function run() {
    if (!signer || busy) return;
    setBusy(true);
    setResult('');
    try {
      const event = await runNativeSignerCheck(signer, Math.floor(Date.now() / 1000));
      if (mounted.current) setResult(`Signature verified. Nothing was published.\nEvent: ${event.id}\nDisposable public key: ${event.pubkey}`);
    } catch {
      if (mounted.current) setResult('Signer check cancelled or unavailable. No event was published.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!signer) return null;
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Native signer check</Text>
    <Text style={styles.detail}>Uses a temporary key and native approval. Your saved identity is unaffected.</Text>
    <ShellPressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
      testID="settings-native-signer-check" style={styles.action} onPress={() => { void run(); }}>
      <Text style={styles.actionText}>{busy ? 'Waiting for native review…' : 'Review test event'}</Text>
    </ShellPressable>
    {result !== '' && <Text selectable accessibilityLiveRegion="polite" testID="settings-native-signer-result" style={styles.result}>{result}</Text>}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  group: { gap: 12 },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 24 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
  action: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 18, minHeight: 56 },
  actionText: { fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
  result: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20 },
});
