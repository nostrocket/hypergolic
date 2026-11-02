/** Isolated QA entry: disposable signing key and compile-gated loopback TLS only. */
import {registerRootComponent, requireNativeModule, requireNativeView} from 'expo';
import {digest, CryptoDigestAlgorithm} from 'expo-crypto';
import {useCallback, useEffect, useState, useSyncExternalStore} from 'react';
import {AppState, Pressable, StyleSheet, Text, View, type NativeSyntheticEvent} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {initializeNativeRandom} from '../../../src/security/crypto-bootstrap';
import {BUNDLED_FIXTURES} from '../../../src/runtime/bundled-catalog';
import {createNativeUploadPort, type UploadModule} from '../../../src/uploads/upload-port';
import {UploadService} from '../../../src/uploads/upload-service';
import type {ApprovalOrigin} from '../../../src/security/approval-service';
import type {NativeCapabilityEvent} from '../../../src/runtime/runtime-owner';
import {UploadWorkspace} from '../../../src/shell/UploadWorkspace';
initializeNativeRandom();
const secret = new Uint8Array(32); secret[31] = 1;
const configuration = {sessionId: 'upload-fixture', epoch: 1, user: getPublicKey(secret), publisher: 'f'.repeat(64),
  appId: 'upload-lab', version: BUNDLED_FIXTURES['upload-lab'].aggregateHash, instanceId: 'upload-fixture', fixture: 'upload-lab', domains: ['upload', 'theme']};
const peerConfiguration = {...configuration, sessionId: 'upload-peer', instanceId: 'upload-peer'};
const queueConfigurations = Array.from({length: 9}, (_, index) => ({...configuration,
  sessionId: 'upload-queue-' + index, instanceId: 'upload-queue-' + index, appId: 'upload-queue-lab', fixture: 'upload-queue-lab',
  version: BUNDLED_FIXTURES['upload-queue-lab'].aggregateHash}));
const configurations = new Map([configuration, peerConfiguration, ...queueConfigurations].map(value => [value.sessionId, value]));
type Event = NativeCapabilityEvent | {type: 'ready' | 'error'; sessionId: string; code?: string};
const Host = requireNativeView<{configuration: string; active: boolean; pickerFaultProof: string; uploadFaultProof: string; style: unknown; onHostEvent(event: NativeSyntheticEvent<Event>): void}>('HypergolicNappletHost');
interface Module extends UploadModule {configureUploadServer(server: string | null): void; configureUploadProof(anchor: string): void}
function Fixture() {
  const [visible, setVisible] = useState(true), [focused, setFocused] = useState(true), [revision, setRevision] = useState(0);
  const [proofFault, setProofFault] = useState('none'), [uploadFault, setUploadFault] = useState('none');
  const [faultControls, setFaultControls] = useState(false);
  const [queueCount, setQueueCount] = useState(0), [queueFocused, setQueueFocused] = useState<number | null>(null);
  const [peerLoaded, setPeerLoaded] = useState(false), [peerFocused, setPeerFocused] = useState(false);
  const [status, setStatus] = useState('Opening upload fixture…');
  const [owner] = useState(() => {
    const native = requireNativeModule<Module>('HypergolicNappletHost');
    const generations = new Map<string, string>(), revoked = new Set<string>();
    const assertActive = (origin: ApprovalOrigin) => {
      const expected = configurations.get(origin.sessionId);
      if (!expected || revoked.has(origin.sessionId) || origin.generation !== generations.get(origin.sessionId) || Object.keys(expected).filter(key => !['fixture', 'domains'].includes(key))
        .some(key => origin[key as keyof ApprovalOrigin] !== expected[key as keyof typeof expected])) throw Error('Fixture revoked');
    };
    const service = new UploadService(createNativeUploadPort(native), {assertActive}, {
      currentIdentity: () => configuration.user,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      sha256: async bytes => Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)), byte => byte.toString(16).padStart(2, '0')).join(''),
      sign: async (snapshot, authority) => {
        authority.assertActive(); const signed = finalizeEvent({...snapshot.authorization, tags: snapshot.authorization.tags.map(tag => [...tag])}, secret); authority.assertActive();
        return {id: signed.id, pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind, content: signed.content, tags: signed.tags, sig: signed.sig};
      },
    });
    return {native, service, receive(event: Event) {
      if (event.type !== 'capability') return;
      const expected = configurations.get(event.sessionId);
      if (!expected || revoked.has(event.sessionId)) return;
      if (!generations.has(event.sessionId)) generations.set(event.sessionId, event.generation);
      if (event.generation === generations.get(event.sessionId) && event.lane === 'upload') service.enqueue(event.token, {...expected, generation: event.generation});
    }, close(sessionId = configuration.sessionId) {revoked.add(sessionId); service.close(sessionId);},
      closeAll() {for (const sessionId of configurations.keys()) {revoked.add(sessionId); service.close(sessionId);}},
      reopen() {revoked.delete(configuration.sessionId); generations.delete(configuration.sessionId);}};
  });
  const snapshot = useSyncExternalStore(useCallback(listener => owner.service.subscribe(listener), [owner]), owner.service.getSnapshot);
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    try {
      const anchor = process.env.EXPO_PUBLIC_UPLOAD_PROOF_ANCHOR;
      if (!anchor) throw Error('Missing disposable anchor');
      owner.native.configureUploadProof(anchor); owner.native.configureUploadServer('https://files.example.com:19943');
      owner.service.foreground(); setPrepared(true); setStatus('Upload fixture ready');
    } catch {setStatus('Upload network proof build is unavailable');}
    return () => owner.closeAll();
  }, [owner]);
  useEffect(() => {
    owner.service.focus(queueFocused !== null ? queueConfigurations[queueFocused]!.sessionId : peerLoaded && peerFocused ? peerConfiguration.sessionId : visible && focused ? configuration.sessionId : null);
  }, [owner, visible, focused, peerLoaded, peerFocused, queueFocused]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {if (state === 'active') owner.service.foreground(); else owner.service.background();});
    const timer = setInterval(() => owner.service.refresh(), 250);
    return () => {listener.remove(); clearInterval(timer);};
  }, [owner]);
  return <View style={styles.root}>
    <Text style={styles.notice}>Upload fixture · disposable identity · loopback TLS</Text>
    <Text testID="upload-native-status" style={styles.notice}>{status}</Text>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => {
      if (visible) {owner.close(); setVisible(false); setStatus('Upload Lab closed');}
      else {owner.reopen(); setProofFault('none'); setUploadFault('none'); setRevision(value => value + 1); setFocused(true); setVisible(true);}
    }}><Text style={styles.label}>{visible ? 'Close Upload Lab' : 'Open Upload Lab'}</Text></Pressable>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => setFocused(value => !value)}><Text style={styles.label}>{focused ? 'Hide Upload Lab' : 'Show Upload Lab'}</Text></Pressable>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => setFaultControls(value => !value)}><Text style={styles.label}>Upload fault controls</Text></Pressable>
    {faultControls && <View style={styles.faults}>{['close', 'replace', 'identity', 'renderer'].map(action =>
      <Pressable key={action} accessibilityRole="button" style={styles.faultButton} onPress={() => {setUploadFault(action); setFaultControls(false); setStatus('Upload fault armed: ' + action);}}>
        <Text style={styles.label}>{'Interrupt upload ' + action}</Text>
      </Pressable>)}</View>}
    <View style={styles.faults}>{['close', 'replace', 'identity', 'renderer'].map(action =>
      <Pressable key={action} accessibilityRole="button" style={styles.faultButton} onPress={() => {setProofFault(action); setStatus('Picker fault armed: ' + action);}}>
        <Text style={styles.label}>{'Arm picker ' + action}</Text>
      </Pressable>)}</View>
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => {
      if (!peerLoaded) {setPeerLoaded(true); setStatus('Loading peer napplet');}
      else {setQueueFocused(null); setPeerFocused(value => !value); setFocused(peerFocused); setStatus(peerFocused ? 'Upload Lab focused' : 'Peer napplet focused');}
    }}><Text style={styles.label}>{!peerLoaded ? 'Load Peer Napplet' : peerFocused ? 'Switch to Upload Lab' : 'Switch to Peer Napplet'}</Text></Pressable>
    {(snapshot.active.length === 2 || queueCount > 0) && <View style={styles.faults}>
      <Pressable accessibilityRole="button" style={styles.faultButton} onPress={() => setQueueCount(value => value === 0 ? 8 : 9)}><Text style={styles.label}>{queueCount === 0 ? 'Load eight queue peers' : 'Load overflow peer'}</Text></Pressable>
      <Pressable accessibilityRole="button" style={styles.faultButton} onPress={() => {setQueueFocused(queueCount === 9 ? 8 : 0); setPeerFocused(false);}}><Text style={styles.label}>Focus queue peer</Text></Pressable>
    </View>}
    <Text testID="upload-queue-counts" style={styles.notice}>{'Active: ' + snapshot.active.length + '; queued: ' + snapshot.pending}</Text>
    {queueConfigurations.slice(0, queueCount).map((value, index) => <Host key={value.sessionId} pickerFaultProof="none" uploadFaultProof="none" configuration={JSON.stringify(value)} active={queueFocused === index} style={queueFocused === index ? styles.host : styles.hiddenHost} onHostEvent={event => owner.receive(event.nativeEvent)} />)}
    {peerLoaded && prepared && <Host pickerFaultProof="none" uploadFaultProof="none" configuration={JSON.stringify(peerConfiguration)} active={peerFocused && queueFocused === null} style={peerFocused && queueFocused === null ? styles.host : styles.hiddenHost} onHostEvent={event => {
      if (event.nativeEvent.type === 'ready') setStatus('Native peer connected'); else owner.receive(event.nativeEvent);
    }} />}
    {visible && prepared && <Host key={revision} pickerFaultProof={proofFault} uploadFaultProof={uploadFault} configuration={JSON.stringify(configuration)} active={focused && !peerFocused && queueFocused === null} style={peerFocused || queueFocused !== null ? styles.hiddenHost : styles.host} onHostEvent={event => {
      const value = event.nativeEvent;
      if (value.type === 'ready') setStatus('Native host connected'); else if (value.type === 'error') {owner.close(); setVisible(false); setStatus('Native host failed: ' + (value.code ?? 'unknown'));}
      else owner.receive(value);
    }} />}
    <UploadWorkspace service={owner.service} snapshot={snapshot} workspace={undefined} blocked={false} />
  </View>;
}
const styles = StyleSheet.create({root: {flex: 1, backgroundColor: '#140f0b'}, host: {flex: 1}, hiddenHost: {position: 'absolute', width: 0, height: 0}, notice: {color: '#f3efeb', fontSize: 12, padding: 8, textAlign: 'center'},
  faults: {flexDirection: 'row', flexWrap: 'wrap'}, faultButton: {width: '50%', minHeight: 48, justifyContent: 'center', alignItems: 'center'},
  button: {minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: '#34251d'}, label: {color: '#e8805d', fontSize: 16}});
function Root() {return <SafeAreaProvider><SafeAreaView style={styles.root}><Fixture /></SafeAreaView></SafeAreaProvider>;}
registerRootComponent(Root);
