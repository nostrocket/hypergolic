import { useEffect, useState } from 'react';
import { Button, StyleSheet, View } from 'react-native';
import { devicePrivacy } from './security/device-privacy';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShellAppearance } from './shell/ShellAppearance';
import { IdentityEntry } from './shell/IdentityEntry';

export default function App() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const open = await devicePrivacy().prepare();
        if (!active) return;
        if (open) setReady(true);
        else setFailed(true);
      } catch { if (active) setFailed(true); }
    }
    void check();
    return () => { active = false; };
  }, [attempt]);
  if (!ready) return <View style={styles.root}>{failed && <Button title="Retry opening Hypergolic" onPress={() => {
    setFailed(false); setAttempt(value => value + 1);
  }} />}</View>;
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><ShellAppearance><IdentityEntry /></ShellAppearance></SafeAreaProvider></GestureHandlerRootView>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
