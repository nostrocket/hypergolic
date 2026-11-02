/** Public-only QA entry. Network mode uses the ordinary native WSS port; fault modes are labelled. */
import {registerRootComponent, requireNativeView} from 'expo';
import * as SQLite from 'expo-sqlite';
import {useEffect, useRef, useState} from 'react';
import {Platform, Pressable, StyleSheet, Text, View, type ViewProps, type NativeSyntheticEvent} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {createCapabilityBroker, type NativeCapabilityPort} from '../../../src/runtime/capability-broker';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {loadNativeRelayQuery} from '../../../src/network/native-relay-query-port';
import {createNativeRelayQuery, type RelayQueryService} from '../../../src/network/native-relay-query';
import {openShellDatabase} from '../../../src/storage/database';
import {openIdentityCache, IDENTITY_DATA_DATABASE} from '../../../src/identity/identity-cache';
import {createIdentityDataService} from '../../../src/identity/identity-service';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import type {NativeRegistration} from '../../../src/runtime/capability-protocol';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';
const sample: {user: string; relay: string} = JSON.parse(process.env.EXPO_PUBLIC_IDENTITY_SAMPLE ?? '{}');
const other = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const cases = ['network', 'offline', 'empty', 'uncached', 'revoked', 'owner-epoch', 'tampered'] as const;
type Event = NativeCapabilityEvent | {type: 'ready' | 'error'; sessionId: string};
const Host = requireNativeView<ViewProps & {configuration: string; active: boolean; onHostEvent(event: NativeSyntheticEvent<Event>): void}>('HypergolicNappletHost');
function Fixture() {
  const [index, setIndex] = useState(0), [revision, setRevision] = useState(0), [visible, setVisible] = useState(true);
  const [prepared, setPrepared] = useState(false), [status, setStatus] = useState('Opening profile fixture…');
  const [receipt, setReceipt] = useState('No profile receipt');
  const receiver = useRef<((event: Event) => void) | null>(null), stop = useRef<(() => void) | null>(null);
  const scenario = cases[index]!;
  useEffect(() => {
    let live = true, ownerActive = true, generation: string | null = null, broker: ReturnType<typeof createCapabilityBroker> | null = null;
    let database: Awaited<ReturnType<typeof openShellDatabase>> | null = null, cache: Awaited<ReturnType<typeof openIdentityCache>> | null = null;
    let attempts = 0, frames = 0, cancelled = 0;
    const timers: ReturnType<typeof setTimeout>[] = [], profileTokens = new Set<string>();
    const platform = Platform.OS === 'ios' ? 'ios' : 'android', native = loadNativeCapabilityPort();
    const user = scenario === 'empty' ? other : scenario === 'uncached' || scenario === 'revoked' || scenario === 'owner-epoch' ? 'e'.repeat(64) : sample.user;
    const configuration = {sessionId: 'identity-profile', epoch: index, user, publisher: 'f'.repeat(64), appId: 'state-lab',
      version: BUNDLED_FIXTURES['state-lab'].aggregateHash, instanceId: 'identity-profile', fixture: 'state-lab', domains: ['identity', 'storage', 'theme']};
    const observed: NativeCapabilityPort = {take(token) {const raw = native.take(token);
      if (raw && JSON.parse(JSON.parse(raw).request).type === 'identity.getProfile') profileTokens.add(token); return raw;},
      isActive: native.isActive, finish(token, response) {native.finish(token, response);
        if (live && profileTokens.has(token)) setReceipt('Profile receipt: attempts ' + attempts + '; frames ' + frames + '; cancelled ' + cancelled + '; reply ' + (response === null ? 'denied' : JSON.parse(response).error ? 'error' : 'success'));
      }};
    const real = loadNativeRelayQuery(() => scenario === 'offline' || scenario === 'uncached' ? [] : [sample.relay]);
    const controlled = createNativeRelayQuery({newInstanceId: native.newInstanceId, cancelPublishedRelay() {cancelled++;},
      async queryPublishedRelay(_id, _url, _wire, sub) {
        frames++;
        if (scenario === 'revoked' || scenario === 'owner-epoch') return new Promise<string[]>(resolve => {
          timers.push(setTimeout(() => {if (scenario === 'owner-epoch') ownerActive = false; else {broker?.revoke(); setVisible(false);}}, 40));
          timers.push(setTimeout(() => {resolve([JSON.stringify(['EOSE', sub])]);}, 220));
        });
        return [JSON.stringify(['EOSE', sub])];
      }}, () => ['wss://relay.example.org']);
    const queries: RelayQueryService = {query(filters, signal, active) {attempts++; return (scenario === 'empty' || scenario === 'revoked' || scenario === 'owner-epoch' ? controlled : real).query(filters, signal, active);}};
    stop.current = () => {broker?.revoke(); setVisible(false);};
    void (async () => {
      database = await openShellDatabase(SQLite, platform);
      cache = await openIdentityCache(SQLite, platform);
      if (scenario === 'tampered') {
        const writer = await SQLite.openDatabaseAsync(IDENTITY_DATA_DATABASE, {useNewConnection: true});
        try {const row = await writer.getFirstAsync<{payload: string}>('SELECT payload FROM identity_cache WHERE user = ? AND cache_key = ?', user, 'profile');
          if (!row) throw Error('Missing native cache'); const events = JSON.parse(row.payload); events[0].sig = '0'.repeat(128);
          await writer.runAsync('UPDATE identity_cache SET payload = ? WHERE user = ? AND cache_key = ?', JSON.stringify(events), user, 'profile');
        } finally {await writer.closeAsync();}
      }
      if (!live) {await cache.close(); await database.close(); return;}
      const identity = createIdentityDataService(cache, queries, () => Date.now() + (scenario === 'offline' ? 300001 : 0));
      receiver.current = event => {
        if (event.type !== 'capability') {if (event.type === 'ready') setStatus('Native profile host connected'); else {broker?.revoke(); setStatus('Native profile host failed');} return;}
        if (event.sessionId !== configuration.sessionId || event.lane !== undefined) return;
        if (generation === null) {generation = event.generation; broker = createCapabilityBroker(database!, observed, {
          registration: {...configuration, generation} as NativeRegistration, assertActive() {if (!live || !ownerActive) throw Error('Profile fixture revoked');}}, undefined, undefined, undefined, identity);}
        if (event.generation === generation) void broker!.dispatch(event.token);
      };
      // Configuration is trusted fixture input, separate from all guest requests.
      config.current = JSON.stringify(configuration); setPrepared(true); setVisible(true); setStatus('Native profile fixture ready');
    })().catch(() => {if (live) setStatus('Native profile fixture unavailable');});
    return () => {live = false; broker?.revoke(); receiver.current = null; timers.forEach(clearTimeout); void cache?.close(); void database?.close();};
  }, [scenario, revision]);
  const config = useRef('');
  return <View style={styles.root}>
    <Text style={styles.text}>{'Profile case: ' + scenario}</Text><Text style={styles.text}>{status}</Text><Text style={styles.text}>{receipt}</Text>
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => {if (visible) stop.current?.(); else {setPrepared(false); setRevision(value => value + 1); setReceipt('No profile receipt');}}}><Text style={styles.text}>{visible ? 'Close Profile Lab' : 'Open Profile Lab'}</Text></Pressable>
      {index < cases.length - 1 && <Pressable accessibilityRole="button" style={styles.button} onPress={() => {stop.current?.(); setPrepared(false); setReceipt('No profile receipt'); setIndex(value => value + 1);}}><Text style={styles.text}>Next profile case</Text></Pressable>}
    </View>
    {prepared && visible && <Host key={scenario + revision} configuration={config.current} active style={styles.host} onHostEvent={event => receiver.current?.(event.nativeEvent)} />}
  </View>;
}
const styles = StyleSheet.create({root: {flex: 1, backgroundColor: '#140f0b'}, host: {flex: 1}, text: {color: '#f3efeb', fontSize: 12, padding: 6, textAlign: 'center'}, actions: {flexDirection: 'row'}, button: {flex: 1, minHeight: 48, justifyContent: 'center', backgroundColor: '#34251d'}});
function Root() {return <SafeAreaProvider><SafeAreaView style={styles.root}><Fixture /></SafeAreaView></SafeAreaProvider>;}
registerRootComponent(Root);
