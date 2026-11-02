import { publicFixtureSigningMethods } from '../public-signing-methods';
/** Isolated QA: real shared shell/admission/persistence; public disposable signer and local source. */
import {registerRootComponent, requireNativeModule} from 'expo';
import {digest, CryptoDigestAlgorithm} from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import {useEffect, useState} from 'react';
import {Platform, StyleSheet, Text, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {initializeNativeRandom} from '../../../src/security/crypto-bootstrap';
import {formatNpub} from '../../../src/security/public-identity';
import {IdentityTransition} from '../../../src/security/identity-transition';
import {VaultError, type VaultSnapshot} from '../../../src/security/identity-vault';
import type {TrustedIdentityOwner} from '../../../src/security/trusted-identity-owner';
import {createApprovalOwner, createUploadOwner} from '../../../src/security/approval-owner';
import {ApprovalService} from '../../../src/security/approval-service';
import {loadNativeApprovalPort} from '../../../src/runtime/native-approval-port';
import {loadNativeCapabilityPort} from '../../../src/runtime/native-capability-port';
import {createRuntimeOwner, type RuntimeOwner} from '../../../src/runtime/runtime-owner';
import {loadNativePublishedTransferPort} from '../../../src/napplets/native-transfer-port';
import {openShellDatabase} from '../../../src/storage/database';
import {assertWorkspaceAvailability} from '../../../src/shell/fixtures';
import {emptyWorkspace} from '../../../src/shell/workspace';
import {IdentityShell} from '../../../src/shell/IdentityShell';
import {UploadService} from '../../../src/uploads/upload-service';
import {loadNativeUploadPort} from '../../../src/uploads/native-upload-port';
import {openNativeUploadSettings, type UploadConfigurationModule} from '../../../src/uploads/upload-settings-native';
import {SIGNED_UPLOAD_EVENT, SIGNED_UPLOAD_ADDRESS, signedUploadBytes} from './published-fixture';

initializeNativeRandom();
const secret = new Uint8Array(32); secret[31] = 1; // Public, fixed test key; never a protected identity.
const publicIdentity: VaultSnapshot = Object.freeze({vaultId: 'public_signed_upload_fixture', revision: 1,
  selectedPubkey: getPublicKey(secret), identities: Object.freeze([Object.freeze({pubkey: getPublicKey(secret),
    addedAt: 1, origin: 'generated' as const, status: 'active' as const})]), pendingDeletion: null});
async function openFixture(): Promise<TrustedIdentityOwner> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw Error('Native fixture required');
  const anchor = process.env.EXPO_PUBLIC_UPLOAD_PROOF_ANCHOR;
  if (!anchor) throw Error('Missing isolated TLS proof configuration');
  const module = requireNativeModule<UploadConfigurationModule & {configureUploadProof(anchor: string): void}>('HypergolicNappletHost');
  module.configureUploadProof(anchor);
  const uploadSettings = await openNativeUploadSettings(SQLite, module);
  await uploadSettings.replace('https://files.example.com:19943');
  const database = await openShellDatabase(SQLite, Platform.OS);
  const vault = Object.freeze({...publicFixtureSigningMethods(() => publicIdentity),getSnapshot: () => publicIdentity,
    select: async (): Promise<VaultSnapshot> => {throw new VaultError('NOT_FOUND');},
    prepareImport: async () => null, cancelImport: () => {}, commitImport: async (): Promise<VaultSnapshot> => {throw new VaultError('AUTHORIZATION_DENIED');}});
  const transition = await IdentityTransition.open({vault, database,
    seed: emptyWorkspace, assertAvailable: assertWorkspaceAvailability});
  let runtime: RuntimeOwner | null = null;
  const approvals = new ApprovalService(loadNativeApprovalPort(), createApprovalOwner(transition, origin => {
    if (!runtime) throw Error('Fixture unavailable'); runtime.assertPublishedApproval(origin);
  }), {sign: async () => {throw Error('Relay signing unavailable in this fixture');},
    publishEvent: async () => {throw Error('Relay publication unavailable in this fixture');}});
  const uploads = new UploadService(loadNativeUploadPort(), createUploadOwner(transition, origin => {
    if (!runtime) throw Error('Fixture unavailable'); runtime.assertPublishedUpload(origin);
  }), {
    currentIdentity: () => transition.getSnapshot().phase === 'ready' ? transition.getSnapshot().session.vault.selectedPubkey : null,
    sha256: async bytes => Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)), byte => byte.toString(16).padStart(2, '0')).join(''),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    sign: async (snapshot, authority) => {
      authority.assertActive(); const event = finalizeEvent({...snapshot.authorization, tags: snapshot.authorization.tags.map(tag => [...tag])}, secret); authority.assertActive();
      return {id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, content: event.content, tags: event.tags, sig: event.sig};
    },
  });
  runtime = createRuntimeOwner(database, transition, loadNativeCapabilityPort(), {service: approvals, destinations: () => []},
    {sqlite: SQLite, native: loadNativePublishedTransferPort(), lookupRelays: () => ['wss://relay.example.org'],
      source: {query: async coordinate => {
        if (coordinate.pubkey !== SIGNED_UPLOAD_EVENT.pubkey || coordinate.identifier !== 'signed-upload-lab') throw Error('Unknown local artifact');
        return [SIGNED_UPLOAD_EVENT];
      }, readHtml: async expectedHash => {
        if (expectedHash !== SIGNED_UPLOAD_EVENT.tags.find(tag => tag[0] === 'path')?.[2]) throw Error('Unknown local bytes');
        return signedUploadBytes();
      }}}, undefined, undefined, undefined, uploads);
  return Object.freeze({transition, formatNpub, approvals, uploads, uploadSettings, runtime, relaySettings: null, resourceSettings: null});
}
function Fixture() {
  const [owner, setOwner] = useState<TrustedIdentityOwner | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {let live = true; void openFixture().then(value => {if (live) setOwner(value); else value.runtime?.revokeAllPublished();}).catch(() => {if (live) setFailed(true);}); return () => {live = false;};}, []);
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}>
    <SafeAreaView edges={['top']}><Text style={styles.notice}>Signed Upload QA · public disposable identity · local source and TLS</Text>
      <Text selectable accessibilityLabel={SIGNED_UPLOAD_ADDRESS} testID="signed-upload-address" style={styles.address}>{SIGNED_UPLOAD_ADDRESS}</Text></SafeAreaView>
    {owner ? <IdentityShell owner={owner} /> : <Text style={styles.notice}>{failed ? 'Signed Upload QA unavailable' : 'Opening signed upload fixture…'}</Text>}
  </View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles = StyleSheet.create({root: {flex: 1, backgroundColor: '#140f0b'}, notice: {color: '#f3efeb', fontSize: 12, padding: 6, textAlign: 'center'}, address: {color: '#f3efeb', fontSize: 9, paddingHorizontal: 8}});
registerRootComponent(Fixture);
