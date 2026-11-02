import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShellAppearance } from './shell/ShellAppearance';
import { IdentityEntry } from './shell/IdentityEntry';

export default function App() {
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><ShellAppearance><IdentityEntry /></ShellAppearance></SafeAreaProvider></GestureHandlerRootView>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
