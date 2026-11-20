import { PublishedLaunchReview } from '../shell/PublishedLaunchReview';
import type { CloseCheckEvent } from '../shell/close-check';
import { useCallback, useContext, useEffect, useRef, useState, type Ref } from 'react';
import {useNativeZoomTarget} from './useNativeZoomTarget';
import type {NativeZoomReply, ZoomResetRegistration} from '../shell/zoom-reset';
import { requireNativeView } from 'expo';
import { ActivityIndicator, Platform, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { ShellPressable as Pressable } from '../shell/ShellPressable';
import type { NappletDescriptor } from '../shell/workspace';
import type { NativeCapabilityEvent, PublishedRuntimeBinding } from './runtime-owner';
import { RuntimeContext } from './RuntimeContext';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { useShellStyles, type ShellPalette, type ShellFonts } from '../shell/theme';

export type HostEvent = { type: 'ready'; sessionId: string; generation?: string } | { type: 'error'; sessionId: string; code: string } | CloseCheckEvent;
interface Props extends ViewProps {
  session: NappletDescriptor;
  closeCheck?: string;
  onZoomTarget?: ZoomResetRegistration;
  active?: boolean;
  inputBlocked?: boolean;
  gameControls?: boolean;
  onHostEvent: (event: NativeSyntheticEvent<HostEvent>) => void;
}
type NativeEvent = HostEvent | NativeCapabilityEvent | NativeZoomReply;
interface NativeProps extends ViewProps {
  ref?: Ref<object>;
  zoomReset?: string;
  sessionId?: string;
  closeCheck?: string;
  configuration?: string;
  publishedArtifact?: string;
  active?: boolean;
  inputBlocked?: boolean;
  gameControls?: boolean;
  onHostEvent: (event: NativeSyntheticEvent<NativeEvent>) => void;
}
const NativeHost = (Platform.OS === 'android' || Platform.OS === 'ios') ? requireNativeView<NativeProps>('HypergolicNappletHost') : null;

/** A component lifetime owns one immutable native generation, despite workspace snapshot updates. */
export function NappletHost(props: Props) {
  return props.session.source === 'published' ? <PublishedNappletHost {...props} /> : <BundledNappletHost {...props} />;
}

function BundledNappletHost({ session, onHostEvent, onZoomTarget, ...props }: Props) {
  const {zoomRef, zoomReady, clearZoomTarget, zoomReply, zoomNativeProps} = useNativeZoomTarget(session.id, props.active === true, onZoomTarget);
  const runtime = useContext(RuntimeContext);
  const [binding] = useState(() => runtime?.open(session) ?? null);
  useEffect(() => () => binding?.revoke(), [binding]);
  const receive = useCallback((event: NativeSyntheticEvent<NativeEvent>) => {
    const message = event.nativeEvent;
    if (message.sessionId !== session.id) return;
    if (zoomReply(message)) return;
    if (message.type === 'capability') { binding?.receive(message); return; }
    if (message.type === 'ready' && message.generation) zoomReady(message.generation);
    if (message.type === 'error') {clearZoomTarget(); binding?.revoke();}
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [binding, onHostEvent, session.id, zoomReady, clearZoomTarget, zoomReply]);
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <NativeHost {...props} {...zoomNativeProps} ref={zoomRef} {...(binding ? { configuration: binding.configuration } : { sessionId: session.id })} onHostEvent={receive} />;
}

function PublishedNappletHost({ session, onHostEvent, onZoomTarget, ...props }: Props) {
  const {zoomRef, zoomReady, clearZoomTarget, zoomReply, zoomNativeProps} = useNativeZoomTarget(session.id, props.active === true, onZoomTarget);
  const { styles, colors } = useShellStyles(createStyles);
  const runtime = useContext(RuntimeContext);
  const [pinned] = useState(() => session);
  const [attempt, setAttempt] = useState(0);
  const [binding, setBinding] = useState<PublishedRuntimeBinding | null>(null);
  const [review, setReview] = useState<NappletConsentReview | null>(null);
  const [error, setError] = useState(false);
  const decision = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    let opened: PublishedRuntimeBinding | null = null;
    if (runtime) void runtime.openPublished(pinned, controller.signal, request => new Promise<boolean>(resolve => {
      if (!mounted || controller.signal.aborted) { resolve(false); return; }
      decision.current = resolve;
      setReview(request);
    })).then(value => {
      if (!mounted || controller.signal.aborted) { value.revoke(); return; }
      opened = value;
      setBinding(value);
    }).catch(() => { if (mounted) setError(true); });
    return () => {
      mounted = false;
      controller.abort();
      decision.current?.(false);
      decision.current = null;
      opened?.revoke();
    };
  }, [attempt, runtime, pinned]);
  const decide = useCallback((accepted: boolean) => {
    decision.current?.(accepted);
    decision.current = null;
    setReview(null);
  }, []);
  const receive = useCallback((event: NativeSyntheticEvent<NativeEvent>) => {
    const message = event.nativeEvent;
    if (message.sessionId !== session.id || !binding) return;
    if (zoomReply(message)) return;
    if (message.type === 'capability') { binding.receive(message); return; }
    if (message.type === 'ready' && message.generation) {
      try { binding.ready(message.generation); zoomReady(message.generation); } catch { /* A stale mount cannot satisfy readiness. */ }
    }
    if (message.type === 'error') { clearZoomTarget(); binding.revoke(); setError(true); }
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [binding, onHostEvent, session.id, zoomReady, clearZoomTarget, zoomReply]);
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <View style={[props.style, styles.container]}>
    {binding && !error ? <NativeHost {...props} {...zoomNativeProps} ref={zoomRef} style={styles.fill} active={props.active} publishedArtifact={binding.publishedArtifact} onHostEvent={receive} /> :
      <View style={styles.center}>{error || !runtime ? <><Text accessibilityRole="header" style={styles.heading}>Unable to open</Text><Text style={styles.detail}>The saved version could not be opened. You can try again or return to your napplets.</Text>
        <Pressable accessibilityRole="button" testID={`published-retry-${session.id}`} onPress={() => { setBinding(null); setError(false); setAttempt(value => value + 1); }} style={styles.action}><Text style={styles.actionText}>Try again</Text></Pressable></> :
        <><ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={styles.heading}>Opening napplet…</Text><Text style={styles.detail}>Checking the saved version and its access.</Text></>}</View>}
    {review && <PublishedLaunchReview target={{...review, requiredDomains: review.domains}}
      ids={{review: `published-review-${session.id}`, approve: `published-approve-${session.id}`, cancel: `published-reject-${session.id}`}}
      changesAccess onAccept={() => decide(true)} onCancel={() => decide(false)} />}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  container: { flex: 1 }, fill: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, textAlign: 'center' },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  action: { minHeight: 48, borderRadius: 0, backgroundColor: colors.primary, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14 },
});
