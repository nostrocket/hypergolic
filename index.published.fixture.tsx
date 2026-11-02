import { useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { PublishedHostLab } from './src/shell/PublishedHostLab';
import { colors } from './src/shell/theme';

/** Isolated public-only Simulator entry; the production entry remains index.ts. */
function PublishedHostFixtureApp() {
  const [showing, setShowing] = useState(true);
  const epoch = useRef(0);
  const sessionAuthority = () => {
    const captured = epoch.current;
    return { assertActive: () => {
      if (captured !== epoch.current) throw new Error('Test session ended');
    } };
  };
  const close = () => { epoch.current++; setShowing(false); };
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider>
    <SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>Signed host QA fixture</Text>
      <Text style={styles.detail}>Isolated native host test with a public signed artifact and no saved identity.</Text>
      {showing ? <PublishedHostLab onClose={close} sessionAuthority={sessionAuthority} />
        : <Pressable accessibilityRole="button" testID="fixture-reopen" onPress={() => setShowing(true)} style={styles.action}>
          <Text style={styles.actionText}>Inspect signed test again</Text>
        </Pressable>}
    </ScrollView></SafeAreaView>
  </SafeAreaProvider></GestureHandlerRootView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 20 },
  title: { color: colors.text, fontSize: 26, fontWeight: '600' },
  detail: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  action: { minHeight: 56, justifyContent: 'center', alignItems: 'center', borderRadius: 16, backgroundColor: colors.accent },
  actionText: { color: colors.background, fontSize: 16, fontWeight: '600' },
});

registerRootComponent(PublishedHostFixtureApp);
