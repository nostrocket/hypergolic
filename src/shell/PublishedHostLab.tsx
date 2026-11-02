import { useCallback, useEffect, useRef, useState } from 'react';
import { requireNativeModule, requireNativeView } from 'expo';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View,
  type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { VerifiedNappletArtifact, VerifiedNappletManifest } from '../napplets/verified-artifact.ts';
import { EmbeddedTestFixtureError, loadEmbeddedTestArtifact } from '../napplets/embedded-test-fixture.ts';
import { stageVerifiedArtifact, type NativePublishedTransferPort } from '../napplets/native-transfer.ts';
import { loadNativePublishedTransferPort } from '../napplets/native-transfer-port';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

type HostEvent = { type: 'ready' | 'error'; sessionId: string; code?: string };
type HostProps = ViewProps & { publishedArtifact: string; active: boolean;
  onHostEvent: (event: NativeSyntheticEvent<HostEvent>) => void };
const NativeHost = Platform.OS === 'android' || Platform.OS === 'ios'
  ? requireNativeView<HostProps>('HypergolicNappletHost') : null;

type Phase = 'checking' | 'review' | 'preparing' | 'running' | 'error';

/** Signed fixture journey; production Settings and isolated native QA use the same host path. */
export function PublishedHostLab({ onClose, sessionAuthority }: {
  onClose: () => void;
  sessionAuthority: () => { assertActive(): void };
}) {
  const { styles, colors } = useShellStyles(createStyles);
  const [phase, setPhase] = useState<Phase>('checking');
  const [manifest, setManifest] = useState<VerifiedNappletManifest | null>(null);
  const [hostInput, setHostInput] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState('Starting host');
  const [failure, setFailure] = useState<string | null>(null);
  const phaseRef = useRef<Phase>('checking');
  const artifactRef = useRef<VerifiedNappletArtifact | null>(null);
  const sessionRef = useRef<{ id: string; port: NativePublishedTransferPort } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const disposed = useRef(false);

  const revoke = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    artifactRef.current?.htmlBytes.fill(0);
    artifactRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) try { session.port.revokePublishedSession(session.id); } catch { /* Native also expires bytes. */ }
  }, []);

  useEffect(() => {
    let live = true;
    disposed.current = false;
    void loadEmbeddedTestArtifact().then(artifact => {
      if (!live || phaseRef.current !== 'checking') { artifact.htmlBytes.fill(0); return; }
      if (artifact.manifest.requiredDomains.length !== 1 || artifact.manifest.requiredDomains[0] !== 'theme') {
        artifact.htmlBytes.fill(0); throw new Error('Unexpected test capability');
      }
      artifactRef.current = artifact;
      setManifest(artifact.manifest);
      phaseRef.current = 'review';
      setPhase('review');
    }).catch(error => { if (live) { setFailure(error instanceof EmbeddedTestFixtureError ? `verification:${error.stage}` : 'verification'); phaseRef.current = 'error'; setPhase('error'); } });
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      revoke();
      phaseRef.current = 'error';
      if (live) { setFailure('background'); setPhase('error'); }
    });
    return () => { live = false; disposed.current = true; subscription.remove(); revoke(); };
  }, [revoke]);

  const open = () => {
    if (phaseRef.current !== 'review' || artifactRef.current === null) return;
    phaseRef.current = 'preparing';
    setPhase('preparing');
    const artifact = artifactRef.current;
    artifactRef.current = null;
    const abort = new AbortController();
    abortRef.current = abort;
    void (async () => {
      const authority = sessionAuthority();
      const assertActive = () => {
        authority.assertActive();
        if (disposed.current || abort.signal.aborted || AppState.currentState !== 'active') throw new Error('Test session ended');
      };
      const module = requireNativeModule<{ newInstanceId(): string }>('HypergolicNappletHost');
      const id = module.newInstanceId();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid native session');
      const port = loadNativePublishedTransferPort();
      assertActive();
      if (!port.registerPublishedSession(id)) throw new Error('Native session unavailable');
      sessionRef.current = { id, port };
      const handle = await stageVerifiedArtifact(artifact, id, port, abort.signal, assertActive);
      assertActive();
      const input = JSON.stringify({ sessionId: id, publisher: artifact.manifest.pubkey,
        appId: artifact.manifest.tags.find(tag => tag[0] === 'd')?.[1],
        eventId: artifact.manifest.eventId, version: artifact.aggregateHash,
        htmlHash: artifact.htmlHash, handle });
      phaseRef.current = 'running';
      setHostInput(input);
      setPhase('running');
    })().catch(() => {
      artifact.htmlBytes.fill(0);
      revoke();
      if (!disposed.current) { setFailure('staging'); phaseRef.current = 'error'; setPhase('error'); }
    });
  };

  const close = () => { revoke(); onClose(); };
  const receive = ({ nativeEvent }: NativeSyntheticEvent<HostEvent>) => {
    if (nativeEvent.sessionId !== sessionRef.current?.id) return;
    if (nativeEvent.type === 'ready') { setHostStatus('Signed test napplet connected'); return; }
    revoke();
    phaseRef.current = 'error';
    setFailure(`native:${nativeEvent.code ?? 'unknown'}`);
    setHostStatus('The signed test napplet could not be loaded.');
    setPhase('error');
  };

  return <View style={styles.container}>
    <Text accessibilityRole="header" style={styles.title}>Signed test napplet</Text>
    {phase === 'checking' || phase === 'preparing' ? <ActivityIndicator color={colors.accent} /> : null}
    {phase === 'checking' && <Text style={styles.detail}>Verifying the signed test artifact…</Text>}
    {phase === 'review' && manifest && <>
      <Text style={styles.detail}>This embedded QA napplet will open with theme access. Its signed event and original HTML have been verified.</Text>
      <Text style={styles.label}>Publisher</Text><Text selectable testID="published-lab-publisher" style={styles.value}>{manifest.pubkey}</Text>
      <Text style={styles.label}>Napplet</Text><Text style={styles.value}>{manifest.tags.find(tag => tag[0] === 'd')?.[1]}</Text>
      <Text style={styles.label}>Signed event</Text><Text selectable style={styles.value}>{manifest.eventId}</Text>
      <Text style={styles.label}>Access</Text><Text style={styles.value}>Theme only</Text>
      <Pressable accessibilityRole="button" testID="published-lab-open" onPress={open} style={styles.action}><Text style={styles.actionText}>Open signed test</Text></Pressable>
    </>}
    {phase === 'preparing' && <Text style={styles.detail}>Preparing verified bytes for the native host…</Text>}
    {phase === 'running' && hostInput && NativeHost && <>
      <Text testID="published-lab-status" accessibilityLiveRegion="polite" style={styles.detail}>{hostStatus}</Text>
      <NativeHost testID="published-lab-host" active publishedArtifact={hostInput} onHostEvent={receive} style={styles.host} />
    </>}
    {phase === 'error' && <Text testID="published-lab-error" accessibilityLiveRegion="polite" style={styles.detail}>The signed test could not continue ({failure ?? 'unknown'}). Close this view and try again.</Text>}
    <Pressable accessibilityRole="button" testID="published-lab-close" onPress={close} style={styles.close}><Text style={styles.closeText}>Close test</Text></Pressable>
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  container: { gap: 12 },
  title: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
  label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono, color: colors.muted, fontSize: 12, marginTop: 6 },
  value: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, },
  action: { minHeight: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 0, backgroundColor: colors.primary, marginTop: 12 },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14 },
  close: { minHeight: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 0, borderWidth: 1, borderColor: colors.border },
  closeText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
  host: { minHeight: 420, backgroundColor: colors.background },
});
