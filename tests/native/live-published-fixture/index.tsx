import { registerRootComponent, requireNativeModule } from 'expo';
import * as SQLite from 'expo-sqlite';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import defaults from '../../../src/config/default-relays.json';
import { loadNativePublishedArtifactSource } from '../../../src/napplets/native-published-source-port';
import { decodeNativePublishedBody, type NativePublishedHttpsPort } from '../../../src/napplets/native-published-https';
import { resolveNappletLink } from '../../../src/napplets/resolve-link';
import { MAX_HTML_BYTES, verifyArtifact, verifyManifest } from '../../../src/napplets/verified-artifact';
import type { PublishedArtifactSource } from '../../../src/napplets/loader';
import { loadNativePublishedTransferPort } from '../../../src/napplets/native-transfer-port';
import { loadNativeApprovalPort } from '../../../src/runtime/native-approval-port';
import { loadNativeCapabilityPort } from '../../../src/runtime/native-capability-port';
import { createRuntimeOwner, type RuntimeOwner } from '../../../src/runtime/runtime-owner';
import { ApprovalService } from '../../../src/security/approval-service';
import { initializeNativeRandom } from '../../../src/security/crypto-bootstrap';
import { createApprovalOwner } from '../../../src/security/approval-owner';
import { formatNpub } from '../../../src/security/public-identity';
import { IdentityTransition } from '../../../src/security/identity-transition';
import { VaultError, type VaultSnapshot } from '../../../src/security/identity-vault';
import type { TrustedIdentityOwner } from '../../../src/security/trusted-identity-owner';
import { assertWorkspaceAvailability } from '../../../src/shell/fixtures';
import { IdentityShell } from '../../../src/shell/IdentityShell';
import { emptyWorkspace } from '../../../src/shell/workspace';
import { colors } from '../../../src/shell/theme';
import { openShellDatabase } from '../../../src/storage/database';

// Public fixture identity only. This entry cannot import, store, reveal, or sign with an nsec.
// Generated once from a random disposable secret that was not stored or printed.
const PUBLIC_IDENTITY = '0349e311d2f7f8e2750e169025728a5bd5ac804c285882928bf098cf8b1e98be';
const CANDIDATE_NADDR = 'naddr1qvzqqqyf8ypzqfngzhsvjggdlgeycm96x4emzjlwf8dyyzdfg4hefp89zpkdgz99qqxxv6tvv5kkyun0waek2us8fz2v6';
const CANDIDATE_EVENT_ID = 'a3c01be3f0d75cd8ff758c78f71ab9446487f01b791f53ac141fce15d1214d0d';
const identity: VaultSnapshot = Object.freeze({ vaultId: 'public_live_published_fixture', revision: 1,
  selectedPubkey: PUBLIC_IDENTITY, identities: Object.freeze([Object.freeze({ pubkey: PUBLIC_IDENTITY,
    addedAt: 1, origin: 'generated' as const, status: 'active' as const })]), pendingDeletion: null });

async function openPublicFixture(): Promise<TrustedIdentityOwner> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') throw new Error('PUBLIC_FIXTURE_UNAVAILABLE');
  initializeNativeRandom();
  const database = await openShellDatabase(SQLite, Platform.OS);
  const vault = Object.freeze({ getSnapshot: () => identity,
    select: async (_pubkey: string): Promise<VaultSnapshot> => { throw new VaultError('NOT_FOUND'); },
    prepareImport: async () => null, cancelImport: () => {}, commitImport: async (): Promise<VaultSnapshot> => { throw new VaultError('AUTHORIZATION_DENIED'); },
  });
  const transition = await IdentityTransition.open({ vault, database,
    seed: emptyWorkspace, assertAvailable: assertWorkspaceAvailability });
  let runtime: RuntimeOwner | null = null;
  const approvals = new ApprovalService(loadNativeApprovalPort(), createApprovalOwner(transition, origin => {
    if (!runtime) throw new Error('PUBLIC_FIXTURE_SIGNING_UNAVAILABLE');
    runtime.assertPublishedApproval(origin);
  }), {
    sign: async () => { throw new Error('PUBLIC_FIXTURE_SIGNING_UNAVAILABLE'); },
    publishEvent: async () => { throw new Error('PUBLIC_FIXTURE_PUBLICATION_UNAVAILABLE'); },
  });
  const nativeSource = loadNativePublishedArtifactSource();
  const observedSource: PublishedArtifactSource = {
    async query(...args) {
      updateOpenDiagnostic('Settings native relay lookup started');
      try {
        const events = await nativeSource.query(...args);
        updateOpenDiagnostic(`Settings native relay lookup returned ${events.length} event(s)`);
        return events;
      } catch (error) {
        updateOpenDiagnostic(`Settings native relay lookup failed: ${boundedFailure(error)}`);
        throw error;
      }
    },
    async readHtml(...args) {
      updateOpenDiagnostic('Settings native HTTPS artifact read started');
      try {
        const bytes = await nativeSource.readHtml(...args);
        updateOpenDiagnostic(`Settings native HTTPS artifact read returned ${bytes.length} bytes`);
        return bytes;
      } catch (error) {
        updateOpenDiagnostic(`Settings native HTTPS artifact read failed: ${boundedFailure(error)}`);
        throw error;
      }
    },
  };
  runtime = createRuntimeOwner(database, transition, loadNativeCapabilityPort(),
    { service: approvals, destinations: () => Object.freeze([...defaults.networkRelays]) },
    { sqlite: SQLite, source: observedSource, native: loadNativePublishedTransferPort(),
      lookupRelays: () => Object.freeze([...defaults.lookupRelays]) });
  return Object.freeze({ transition, formatNpub, approvals, runtime, relaySettings: null });
}

let state: Readonly<{ owner: TrustedIdentityOwner | null; error: boolean; openDiagnostic: string }> =
  Object.freeze({ owner: null, error: false, openDiagnostic: 'Settings source idle' });
let started = false;
const listeners = new Set<() => void>();
function boundedFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  return `${error.name}: ${error.message.replace(/\s+/g, ' ').slice(0, 120)}`;
}
function updateOpenDiagnostic(value: string) {
  state = Object.freeze({ ...state, openDiagnostic: value });
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function snapshot() { return state; }
function start() {
  if (started) return;
  started = true;
  void openPublicFixture().then(owner => {
    state = Object.freeze({ ...state, owner, error: false });
    for (const listener of listeners) listener();
  }).catch(() => {
    state = Object.freeze({ ...state, owner: null, error: true });
    for (const listener of listeners) listener();
  });
}

function LivePublishedFixture() {
  const current = useSyncExternalStore(subscribe, snapshot);
  const [probe, setProbe] = useState('Native transport not probed');
  const [probing, setProbing] = useState(false);
  useEffect(start, []);
  async function probeNativeSource() {
    if (probing) return;
    setProbing(true);
    const controller = new AbortController();
    let stage = 'relay query';
    try {
      const coordinate = resolveNappletLink(CANDIDATE_NADDR);
      const source = loadNativePublishedArtifactSource();
      setProbe('Querying native relays…');
      const lookup = { kind: coordinate.kind, pubkey: coordinate.pubkey, identifier: coordinate.identifier };
      const events = await source.query(lookup, defaults.lookupRelays, null, controller.signal);
      stage = 'manifest verification';
      setProbe(`Native relays returned ${events.length} event(s)`);
      const checked = await Promise.all(events.map(async event => {
        try { return await verifyManifest(coordinate, event); } catch { return null; }
      }));
      const manifest = checked.find(item => item?.id === CANDIDATE_EVENT_ID);
      if (!manifest) throw new Error('Expected signed event absent');
      stage = 'direct native HTTPS fetch';
      setProbe('Signed event verified; fetching raw native HTTPS artifact…');
      const server = manifest.serverHints.find(hint => hint === 'https://blossom.ditto.pub/');
      if (!server) throw new Error('Expected signed Blossom hint absent');
      const nativePort = requireNativeModule<NativePublishedHttpsPort>('HypergolicNappletHost');
      const encoded = await nativePort.fetchPublishedHttps(nativePort.newInstanceId(),
        new URL(manifest.expectedHtmlHash, server).href);
      const directBytes = decodeNativePublishedBody(encoded);
      await verifyArtifact(manifest, directBytes);
      stage = 'single signed Blossom source';
      setProbe(`Raw native HTTPS verified ${directBytes.length} bytes; checking source adapter…`);
      const singleBytes = await source.readHtml(manifest.expectedHtmlHash, [server], MAX_HTML_BYTES, controller.signal);
      await verifyArtifact(manifest, singleBytes);
      stage = 'all signed Blossom sources';
      setProbe(`Single signed Blossom source verified ${singleBytes.length} bytes; checking fallback…`);
      const bytes = await source.readHtml(manifest.expectedHtmlHash, manifest.serverHints, MAX_HTML_BYTES, controller.signal);
      stage = 'artifact verification';
      await verifyArtifact(manifest, bytes);
      setProbe(`Native relay and HTTPS artifact verified (${bytes.length} bytes)`);
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? ` / ${error.cause.name}` : '';
      const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 160) : '';
      setProbe(`${stage} failed: ${error instanceof Error ? error.name : 'unknown error'}${detail ? `: ${detail}` : ''}${cause}`);
    } finally {
      controller.abort();
      setProbing(false);
    }
  }
  return <GestureHandlerRootView style={styles.root}><SafeAreaProvider><View style={styles.root}>
    <SafeAreaView edges={['top']} style={styles.notice}>
      <Text testID="live-fixture-label" style={styles.label}>Live published QA · public identity · signing unavailable</Text>
      <Text selectable testID="live-fixture-address" style={styles.address}>{CANDIDATE_NADDR}</Text>
      <Pressable accessibilityRole="button" testID="live-fixture-probe" disabled={probing}
        accessibilityState={{ disabled: probing }} onPress={() => { void probeNativeSource(); }} style={styles.probe}>
        <Text style={styles.probeText}>Probe native source</Text>
      </Pressable>
      <Text testID="live-fixture-probe-result" style={styles.label}>{probe}</Text>
      <Text testID="live-fixture-open-diagnostic" style={styles.label}>{current.openDiagnostic}</Text>
    </SafeAreaView>
    {current.owner ? <IdentityShell owner={current.owner} />
      : <Text style={styles.label}>{current.error ? 'Live published fixture unavailable' : 'Opening public live fixture…'}</Text>}
  </View></SafeAreaProvider></GestureHandlerRootView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  notice: { backgroundColor: colors.surface, paddingHorizontal: 12, paddingBottom: 6, gap: 4 },
  label: { color: colors.text, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  address: { color: colors.muted, fontSize: 10, lineHeight: 14 },
  probe: { alignSelf: 'center', minHeight: 40, paddingHorizontal: 14, justifyContent: 'center',
    borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  probeText: { color: colors.text, fontSize: 13 },
});
registerRootComponent(LivePublishedFixture);
