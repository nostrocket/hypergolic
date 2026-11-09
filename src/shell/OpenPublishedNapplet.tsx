import { MEDIA_ACCESS_DETAIL } from '../runtime/support-report';
import { TrustedBand } from './TrustedBand';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShellModal as Modal } from './ShellModal';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import type { SettingsActions } from './Shell';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { resolvePublishedReference } from '../napplets/resolve-link';
import { publishedOpenFailureText } from './published-settings-actions';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

/** A trusted settings surface for one explicit published open. */
export function OpenPublishedNapplet({ open }: { open: SettingsActions['openPublished'] }) {
  const { styles, colors } = useShellStyles(createStyles);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<NappletConsentReview | null>(null);
  const pending = useRef<AbortController | null>(null);
  const decision = useRef<{review: NappletConsentReview; resolve(accepted: boolean): void} | null>(null);
  useEffect(() => () => { pending.current?.abort(); decision.current?.resolve(false); decision.current = null; }, []);
  const settle = (accepted: boolean) => {
    const selected = decision.current;
    decision.current = null;
    selected?.resolve(accepted);
    setReview(null);
  };
  const decide = (accepted: boolean) => {
    if (decision.current?.review === review) settle(accepted);
  };
  const cancel = () => {
    pending.current?.abort(); pending.current = null;
    settle(false); setBusy(false); setError('');
  };
  const start = () => {
    if (busy || pending.current || !link.trim()) return;
    try { resolvePublishedReference(link.trim()); }
    catch { setError('Paste a named napplet address (naddr) or a snapshot event link (nevent).'); return; }
    Keyboard.dismiss();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    void open(link.trim(), controller.signal, request => new Promise<boolean>(resolve => {
      if (controller.signal.aborted) { resolve(false); return; }
      decision.current = {review: request, resolve};
      setReview(request);
    })).catch(error => {
      if (!controller.signal.aborted && pending.current === controller) setError(publishedOpenFailureText(error));
    }).finally(() => {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    });
  };
  if (review) return <OpenAccessReview review={review} decide={decide} />;
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Open a napplet</Text>
    <Text style={styles.detail}>Paste a napplet address. We’ll check its signed version, then show you who published it and what access it needs.</Text>
    <Text style={styles.addressLabel}>Napplet address</Text>
    <TextInput testID="settings-napplet-address" accessibilityLabel="Napplet address" value={link} onChangeText={value => { setLink(value); setError(''); }}
      autoCapitalize="none" autoCorrect={false} maxLength={8192} editable={!busy} placeholder="naddr1… or nevent1…" placeholderTextColor={colors.muted}
      style={styles.input} returnKeyType="done" onSubmitEditing={start} />
    {error !== '' && <Text testID="settings-napplet-error" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    {busy && <Text testID="settings-napplet-loading" accessibilityLiveRegion="polite" style={styles.detail}>Finding and verifying the signed napplet…</Text>}
    <Pressable accessibilityRole="button" testID="settings-open-napplet" disabled={busy || !link.trim()} accessibilityState={{ disabled: busy || !link.trim() }} onPress={start} style={[styles.action, (busy || !link.trim()) && styles.disabled]}>
      {busy ? <ActivityIndicator color={colors.background} /> : <Text style={styles.actionText}>Verify and open</Text>}
    </Pressable>
    {busy && <Pressable accessibilityRole="button" testID="settings-napplet-cancel" onPress={cancel} style={styles.secondary}><Text style={styles.secondaryText}>Cancel opening</Text></Pressable>}
  </View>;
}

function OpenSourceReview({review}: {review:NappletConsentReview}) {
  const {styles} = useShellStyles(createStyles);
  return <>
    <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{review.publisher}</Text>
    <Text style={styles.detail}>{review.snapshot ? 'Snapshot (kind 5129)' : 'Napplet'}</Text><Text selectable style={styles.claim}>{review.snapshot?.title ?? review.appId}</Text>
    <Text style={styles.detail}>Signed event</Text><Text selectable style={styles.claim}>{review.eventId}</Text>
  </>;
}

function OpenAccessReview({review, decide}: {review: NappletConsentReview; decide(accepted: boolean): void}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  return <Modal visible transparent animationType="none" onRequestClose={() => decide(false)}><View style={[styles.backdrop, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}><View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal><TrustedBand /><ScrollView contentContainerStyle={styles.review} testID="settings-napplet-review">
    <Text accessibilityRole="header" style={styles.title}>Allow this napplet?</Text>
    <OpenSourceReview review={review}/>
    {(review.domains.includes('resource') || review.optionalDomains.includes('resource')) && <Text style={styles.detail}>Resource access allows bounded downloads from public HTTPS sites and your configured Blossom servers. Files stay in memory while this napplet is loaded.</Text>}
    {(review.domains.includes('media') || review.optionalDomains.includes('media')) && <Text style={styles.detail}>{MEDIA_ACCESS_DETAIL}</Text>}
    {(review.domains.includes('upload') || review.optionalDomains.includes('upload')) && <Text style={styles.detail}>Upload access allows this napplet to read files you select. Every upload still needs your separate approval of the file, identity and server.</Text>}
    <Text style={styles.detail}>{review.optionalDomains.length ? 'Required access · ' : 'Requested access: '}{review.domains.join(', ') || 'none'}</Text>
    {review.optionalDomains.length > 0 && <Text style={styles.detail}>Optional access · {review.optionalDomains.join(', ')}</Text>}
    {(review.domains.includes('keys') || review.optionalDomains.includes('keys')) &&
      <Text style={styles.detail}>Keys lets this napplet use hardware shortcuts while it has focus.</Text>}
    {review.unsupportedDomains.length > 0 && <Text testID="settings-napplet-unsupported" accessibilityLiveRegion="polite" style={styles.error}>Required capabilities unavailable · {review.unsupportedDomains.join(', ')}. The napplet can open with limited features.</Text>}
    {review.unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Optional capabilities unavailable · {review.unsupportedOptionalDomains.join(', ')}</Text>}
    <Pressable accessibilityRole="button" testID="settings-napplet-approve" onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Allow and open</Text></Pressable>
    <Pressable accessibilityRole="button" testID="settings-napplet-reject" onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
  </ScrollView></View></View></Modal>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.shade },
  sheet: { maxHeight: '92%', backgroundColor: colors.surface },
  disabled: { opacity: 0.45 },
  addressLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.muted },
  group: { gap: 12 }, title: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 22 },
  error: { fontFamily: fonts.body, color: colors.accent, fontSize: 15, lineHeight: 22 },
  input: { fontFamily: fonts.body, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 0, minHeight: 56, padding: 16, fontSize: 16 },
  action: { padding: 18, minHeight: 56, borderRadius: 0, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  review: { gap: 16, padding: 24 },
  claim: { fontFamily: fonts.mono, color: colors.text, fontSize: 12 },
  secondary: { padding: 18, minHeight: 56, borderRadius: 0, borderColor: colors.border, borderWidth: 1, alignItems: 'center' },
  secondaryText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
});
