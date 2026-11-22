import {randomUUID} from 'expo-crypto';
import { UnavailableBundledVersion } from '../shell/fixtures';
import { PublishedLaunchReview } from '../shell/PublishedLaunchReview';
import type { CloseCheckEvent } from '../shell/close-check';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import {useNativeZoomTarget} from './useNativeZoomTarget';
import type {NativeZoomReply, ZoomResetRegistration} from '../shell/zoom-reset';
import { requireNativeView } from 'expo';
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
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
  const [binding] = useState(() => {
    try { return runtime?.open(session) ?? null; }
    catch (error) {
      if (error instanceof UnavailableBundledVersion) return error;
      throw error;
    }
  });
  const unavailable = binding instanceof UnavailableBundledVersion;
  const liveBinding = unavailable ? null : binding;
  useEffect(() => () => liveBinding?.revoke(), [liveBinding]);
  const receive = useCallback((event: NativeSyntheticEvent<NativeEvent>) => {
    const message = event.nativeEvent;
    if (message.sessionId !== session.id) return;
    if (zoomReply(message)) return;
    if (message.type === 'capability') { liveBinding?.receive(message); return; }
    if (message.type === 'ready' && message.generation) zoomReady(message.generation);
    if (message.type === 'error') {clearZoomTarget(); liveBinding?.revoke();}
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [liveBinding, onHostEvent, session.id, zoomReady, clearZoomTarget, zoomReply]);
  if (unavailable) return <Text>This bundled version is unavailable. Close this card to open the current version.</Text>;
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <NativeHost {...props} {...zoomNativeProps} ref={zoomRef} {...(liveBinding ? { configuration: liveBinding.configuration } : { sessionId: session.id })} onHostEvent={receive} />;
}

const noCheckpoint = () => '';
const noCheckpointSubscription = () => () => undefined;

/** A mounted binding owns one timer across blur, foreground changes and restore. */
function watchCheckpoint(binding: PublishedRuntimeBinding, background: boolean,
  canSuspend: () => boolean, onRestoreFailure: () => void) {
  const checkpoint = binding.checkpoint!;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  function checkRestore() {
    if (!checkpoint.restoring()) return;
    binding.revoke();
    onRestoreFailure();
  }
  function retrySave() {
    if (!canSuspend()) checkpoint.request(true, randomUUID);
  }
  function refresh() {
    clearTimeout(timeout);
    if (AppState.currentState !== 'active') { checkpoint.cancel(); return; }
    const command = checkpoint.request(background, randomUUID);
    if (command?.id.startsWith('restore-')) timeout = setTimeout(checkRestore, 17_000);
    // A request in flight at blur can delay the guest's first durable save.
    else if (background) timeout = setTimeout(retrySave, 3_000);
  }
  refresh();
  const subscription = AppState.addEventListener('change', refresh);
  return () => { clearTimeout(timeout); subscription.remove(); };
}

function PublishedNappletHost({ session, onHostEvent, onZoomTarget, ...props }: Props) {
  const {zoomRef, zoomReady, clearZoomTarget, zoomReply, zoomNativeProps} = useNativeZoomTarget(session.id, props.active === true, onZoomTarget);
  const { styles, colors } = useShellStyles(createStyles);
  const runtime = useContext(RuntimeContext);
  const [pinned] = useState(() => session);
  const [attempt, setAttempt] = useState(0);
  const [binding, setBinding] = useState<PublishedRuntimeBinding | null>(null);
  const [ready, setReady] = useState<PublishedRuntimeBinding | null>(null);
  const [review, setReview] = useState<NappletConsentReview | null>(null);
  const [error, setError] = useState(false);
  const checkpoint = binding?.checkpoint;
  const checkpointCommand = useSyncExternalStore(checkpoint?.subscribe ?? noCheckpointSubscription, checkpoint?.getSnapshot ?? noCheckpoint);
  const isRestoring = checkpoint?.restoring() === true;
  useLayoutEffect(() => {
    if (!binding || binding !== ready || !checkpoint || error) return;
    return watchCheckpoint(binding, !props.active && !props.closeCheck,
      () => runtime?.canSuspend(pinned) === true, () => setError(true));
  }, [ready, binding, checkpoint, props.active, props.closeCheck, isRestoring, runtime, pinned, error]);
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
      try {
        binding.ready(message.generation);
        zoomReady(message.generation);
        setReady(binding);
        if (binding.checkpoint?.restoring()) return;
      } catch { return; }
    }
    if (message.type === 'close-check' && (message.id.startsWith('resume-') || message.id.startsWith('restore-'))) {
      const restoring = binding.checkpoint?.restoring() === true;
      if (!binding.checkpoint?.receive(message) || !restoring) return;
      if (binding.checkpoint.restoring()) {binding.revoke(); setError(true); return;}
      onHostEvent({...event, nativeEvent: {type: 'ready', sessionId: session.id, generation: message.generation}});
      return;
    }
    if (message.type === 'error') { clearZoomTarget(); binding.revoke(); setError(true); }
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [binding, onHostEvent, session.id, zoomReady, clearZoomTarget, zoomReply]);
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <View style={[props.style, styles.container]}>
    {binding && !error ? <NativeHost {...props} {...zoomNativeProps} closeCheck={isRestoring ? checkpointCommand : props.closeCheck || checkpointCommand} ref={zoomRef}
      importantForAccessibility={isRestoring ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={isRestoring}
      style={styles.fill} active={props.active} publishedArtifact={binding.publishedArtifact} onHostEvent={receive} /> :
      <View style={styles.center}>{error || !runtime ? <><Text accessibilityRole="header" style={styles.heading}>Unable to open</Text><Text style={styles.detail}>The saved version could not be opened. You can try again or return to your napplets.</Text>
        <Pressable accessibilityRole="button" testID={`published-retry-${session.id}`} onPress={() => { setBinding(null); setError(false); setAttempt(value => value + 1); }} style={styles.action}><Text style={styles.actionText}>Try again</Text></Pressable></> :
        <><ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={styles.heading}>Opening napplet…</Text><Text style={styles.detail}>Checking the saved version and its access.</Text></>}</View>}
    {isRestoring && !error && <View style={[StyleSheet.absoluteFill, styles.restoring]}>
      <ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={styles.heading}>Restoring draft…</Text>
    </View>}
    {review && <PublishedLaunchReview target={{...review, requiredDomains: review.domains}}
      ids={{review: `published-review-${session.id}`, approve: `published-approve-${session.id}`, cancel: `published-reject-${session.id}`}}
      changesAccess onAccept={() => decide(true)} onCancel={() => decide(false)} />}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  container: { flex: 1 }, fill: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20 },
  restoring: { justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, gap: 16 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, textAlign: 'center' },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  action: { minHeight: 48, borderRadius: 0, backgroundColor: colors.primary, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14 },
});
