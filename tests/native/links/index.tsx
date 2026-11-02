/** Isolated public-only link fixture; production native review and OS opening. */
import {registerRootComponent, requireNativeView, requireNativeModule} from 'expo';
import {useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
type Event = {type: string; code?: string};
const Host = requireNativeView<ViewProps & {configuration: string; active: boolean; onHostEvent(event: NativeSyntheticEvent<Event>): void}>('HypergolicNappletHost');
const native = requireNativeModule<{synchronizeLinkOwner(user: string, epoch: number, available: boolean): void}>('HypergolicNappletHost');
const USERS = ['79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'];
function Fixture() {
  const owner = useRef({user: USERS[0], epoch: 0});
  const [captured, setCaptured] = useState(() => {native.synchronizeLinkOwner(owner.current.user, 0, true); return {...owner.current};});
  const [generation, setGeneration] = useState(0), [visible, setVisible] = useState(true), [focused, setFocused] = useState(true);
  const [status, setStatus] = useState('Connecting link fixture');
  const configuration = JSON.stringify({sessionId: 'resource-link-' + generation, epoch: captured.epoch,
    user: captured.user, publisher: 'f'.repeat(64),
    appId: 'resource-lab', version: BUNDLED_FIXTURES['resource-lab'].aggregateHash,
    instanceId: 'resource-link-' + generation, fixture: 'resource-lab', domains: ['resource', 'link', 'theme']});
  function toggle() {
    if (visible) {setVisible(false); setStatus('Link fixture closed');}
    else {native.synchronizeLinkOwner(owner.current.user, owner.current.epoch, true); setCaptured({...owner.current}); setGeneration(value => value + 1); setFocused(true); setVisible(true); setStatus('Connecting link fixture');}
  }
  function schedule(kind: 'hide' | 'close' | 'identity' | 'pause') {
    setStatus('Scheduled link ' + kind);
    setTimeout(() => {
      if (kind === 'hide') {setFocused(false); setStatus('Link fixture hidden');}
      else if (kind === 'close') {setVisible(false); setStatus('Link fixture closed');}
      else {
        if (kind === 'identity') owner.current = {user: owner.current.user === USERS[0] ? USERS[1] : USERS[0], epoch: owner.current.epoch + 1};
        native.synchronizeLinkOwner(owner.current.user, owner.current.epoch, kind === 'identity');
        setStatus(kind === 'identity' ? 'Link identity changed' : 'Link owner paused');
      }
    }, 6000);
  }
  return <View style={styles.root}>
    <Text style={styles.notice}>Public-only link fixture · unsigned embedded Resource Lab</Text>
    <Text style={styles.notice}>{status}</Text>
    <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}><Text style={styles.label}>{visible ? 'Close Resource Lab' : 'Open Resource Lab'}</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={() => setFocused(value => !value)} style={styles.button}><Text style={styles.label}>{focused ? 'Hide Resource Lab' : 'Show Resource Lab'}</Text></Pressable>
    <View style={styles.row}>
      <Pressable accessibilityRole="button" onPress={() => schedule('hide')} style={styles.small}><Text style={styles.smallLabel}>Hide in six seconds</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => schedule('close')} style={styles.small}><Text style={styles.smallLabel}>Close in six seconds</Text></Pressable>
    </View>
    <View style={styles.row}>
      <Pressable accessibilityRole="button" onPress={() => schedule('identity')} style={styles.small}><Text style={styles.smallLabel}>Change identity in six seconds</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => schedule('pause')} style={styles.small}><Text style={styles.smallLabel}>Pause owner in six seconds</Text></Pressable>
    </View>
    {visible ? <Host key={generation} configuration={configuration} active={focused} style={styles.host}
      onHostEvent={event => {if (event.nativeEvent.type === 'ready') setStatus('Native link host connected'); else if (event.nativeEvent.type === 'error') setStatus('Native link host failed: ' + event.nativeEvent.code);}} /> : null}
  </View>;
}
const styles = StyleSheet.create({root: {flex: 1, backgroundColor: '#140f0b'}, host: {flex: 1}, row: {flexDirection: 'row'}, small: {flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 4}, smallLabel: {color: '#e8805d', fontSize: 12, textAlign: 'center'}, notice: {color: '#f3efeb', fontSize: 12, padding: 6, textAlign: 'center'}, button: {minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#34251d'}, label: {color: '#e8805d', fontSize: 16}});
function Root() {return <SafeAreaProvider><SafeAreaView style={styles.root}><Fixture /></SafeAreaView></SafeAreaProvider>;}
registerRootComponent(Root);
