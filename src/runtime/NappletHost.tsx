import { TrustedBand } from '../shell/TrustedBand';
import type { CloseCheckEvent } from '../shell/close-check';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { requireNativeView } from 'expo';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View, type NativeSyntheticEvent, type ViewProps } from 'react-native';
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
  active?: boolean;
  onHostEvent: (event: NativeSyntheticEvent<HostEvent>) => void;
}
type NativeEvent = HostEvent | NativeCapabilityEvent;
interface NativeProps extends ViewProps {
  sessionId?: string;
  closeCheck?: string;
  configuration?: string;
  publishedArtifact?: string;
  active?: boolean;
  onHostEvent: (event: NativeSyntheticEvent<NativeEvent>) => void;
}
const NativeHost = (Platform.OS === 'android' || Platform.OS === 'ios') ? requireNativeView<NativeProps>('HypergolicNappletHost') : null;

/** A component lifetime owns one immutable native generation, despite workspace snapshot updates. */
export function NappletHost(props: Props) {
  return props.session.source === 'published' ? <PublishedNappletHost {...props} /> : <BundledNappletHost {...props} />;
}

function BundledNappletHost({ session, onHostEvent, ...props }: Props) {
  const runtime = useContext(RuntimeContext);
  const [binding] = useState(() => runtime?.open(session) ?? null);
  useEffect(() => () => binding?.revoke(), [binding]);
  const receive = useCallback((event: NativeSyntheticEvent<NativeEvent>) => {
    const message = event.nativeEvent;
    if (message.sessionId !== session.id) return;
    if (message.type === 'capability') { binding?.receive(message); return; }
    if (message.type === 'error') binding?.revoke();
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [binding, onHostEvent, session.id]);
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <NativeHost {...props} {...(binding ? { configuration: binding.configuration } : { sessionId: session.id })} onHostEvent={receive} />;
}

function PublishedNappletHost({ session, onHostEvent, ...props }: Props) {
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
    if (message.type === 'capability') { binding.receive(message); return; }
    if (message.type === 'error') { binding.revoke(); setError(true); }
    onHostEvent(event as NativeSyntheticEvent<HostEvent>);
  }, [binding, onHostEvent, session.id]);
  if (NativeHost === null) return <Text>Napplet execution is available in the Android and iOS builds.</Text>;
  return <View style={[props.style, styles.container]}>
    {binding && !error ? <NativeHost {...props} style={styles.fill} active={props.active} publishedArtifact={binding.publishedArtifact} onHostEvent={receive} /> :
      <View style={styles.center}>{error || !runtime ? <><Text accessibilityRole="header" style={styles.heading}>Unable to open</Text><Text style={styles.detail}>The saved version could not be opened. You can try again or return to your napplets.</Text>
        <Pressable accessibilityRole="button" testID={`published-retry-${session.id}`} onPress={() => { setBinding(null); setError(false); setAttempt(value => value + 1); }} style={styles.action}><Text style={styles.actionText}>Try again</Text></Pressable></> :
        <><ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={styles.heading}>Opening napplet…</Text><Text style={styles.detail}>Checking the saved version and its access.</Text></>}</View>}
    {review && <View style={styles.review} testID={`published-review-${session.id}`}>
      <TrustedBand label="Napplet access" /><ScrollView contentContainerStyle={styles.reviewContent}><Text accessibilityRole="header" style={styles.heading}>Open this napplet?</Text>
      <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{review.publisher}</Text>
      <Text style={styles.detail}>Napplet</Text><Text selectable style={styles.claim}>{review.appId}</Text>
      {review.domains.includes('upload') && <Text style={styles.detail}>Files you select become readable by this napplet. Every upload needs separate approval of the file, identity and server.</Text>}
      <Text style={styles.detail}>Access: {review.domains.length ? review.domains.join(', ') : 'none'}</Text>
      {review.unsupportedDomains.length > 0 && <Text accessibilityLiveRegion="polite" style={styles.detail}>Unavailable: {review.unsupportedDomains.join(', ')}. This napplet can open, but features using these capabilities will not work. They will not be granted.</Text>}
      <Pressable accessibilityRole="button" testID={`published-approve-${session.id}`} onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Allow and open</Text></Pressable>
      <Pressable accessibilityRole="button" testID={`published-reject-${session.id}`} onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Cancel</Text></Pressable></ScrollView>
    </View>}
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  container: { flex: 1 }, fill: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, textAlign: 'center' }, claim: { fontFamily: fonts.mono, color: colors.text, fontSize: 13 },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  review: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.background },
  reviewContent: { padding: 20, gap: 16, flexGrow: 1 },
  secondary: { minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  secondaryText: { fontFamily: fonts.strong, color: colors.text, fontSize: 14, letterSpacing: 1.8, textTransform: 'uppercase' },
  action: { minHeight: 48, borderRadius: 0, backgroundColor: colors.primary, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14 },
});
