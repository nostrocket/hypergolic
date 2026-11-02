import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { SettingsActions } from './Shell';
import type { NappletDescriptor } from './workspace';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import type { PublishedUpdateReview } from '../napplets/published-session';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { capabilityCompatibility } from '../runtime/support-report';
import { useIdentityOwner } from './IdentityOwnerContext';

type Review = { kind: 'update'; request: PublishedUpdateReview } | { kind: 'access'; request: NappletConsentReview };

function PublishedCapabilityDetails({session}: {session: NappletDescriptor}) {
  const { styles } = useShellStyles(createStyles);
  const {runtime} = useIdentityOwner();
  let requested: readonly string[] | null = null;
  try { requested = runtime?.publishedCapabilities(session) ?? null; } catch { /* Closed or stale sessions have no live claims. */ }
  if (!requested) return null;
  return <Text testID={`published-capabilities-${session.id}`} style={styles.detail}>Requested: {requested.join(', ') || 'none'}. Unavailable: {capabilityCompatibility(requested).unsupportedDomains.join(', ') || 'none'}.</Text>;
}

/** Discover first; a verified candidate never changes the running pin without a separate decision. */
export function UpdatePublishedNapplet({ session, check }: {
  session: NappletDescriptor; check: SettingsActions['checkPublishedUpdate'];
}) {
  const { styles, colors } = useShellStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [status, setStatus] = useState('');
  const pending = useRef<AbortController | null>(null);
  const decision = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => { pending.current?.abort(); decision.current?.(false); decision.current = null; }, []);
  const decide = (accepted: boolean) => {
    decision.current?.(accepted);
    decision.current = null;
    setReview(null);
  };
  const requestDecision = (next: Review, controller: AbortController) => new Promise<boolean>(resolve => {
    if (controller.signal.aborted) { resolve(false); return; }
    decision.current = resolve;
    setReview(next);
  });
  const start = () => {
    if (busy || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setStatus('');
    void check(session, controller.signal,
      request => requestDecision({ kind: 'update', request }, controller),
      request => requestDecision({ kind: 'access', request }, controller))
      .then(updated => { if (!controller.signal.aborted && !updated) setStatus('This is the latest verified version available from your Lookup relays.'); })
      .catch(() => { if (!controller.signal.aborted) setStatus('Update cancelled or unavailable. The current version remains open.'); })
      .finally(() => {
        if (pending.current === controller) pending.current = null;
        if (!controller.signal.aborted) setBusy(false);
      });
  };
  if (review?.kind === 'update') return <View style={styles.card} testID={`published-update-review-${session.id}`}>
    <Text accessibilityRole="header" style={styles.title}>Use this verified update?</Text>
    <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{review.request.publisher}</Text>
    <Text style={styles.detail}>Napplet</Text><Text selectable style={styles.claim}>{review.request.appId}</Text>
    <Text style={styles.detail}>Current event</Text><Text selectable style={styles.claim}>{review.request.previousEventId}</Text>
    <Text style={styles.detail}>New event</Text><Text selectable style={styles.claim}>{review.request.nextEventId}</Text>
    {review.request.domains.includes('resource') && <Text style={styles.detail}>Resource access allows bounded public HTTPS downloads and your configured Blossom servers, retained in memory while loaded.</Text>}
    <Text style={styles.detail}>Requested access: {review.request.domains.length ? review.request.domains.join(', ') : 'none'}</Text>
    <Text style={styles.warning}>Unavailable: {capabilityCompatibility(review.request.domains).unsupportedDomains.join(', ') || 'none'}. Features using unavailable capabilities will not work.</Text>
    <Text style={styles.warning}>The current napplet will close. Unsaved changes and pending signing requests will be lost; saved napplet data stays available.</Text>
    <Pressable accessibilityRole="button" testID={`published-update-accept-${session.id}`} onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Close and use update</Text></Pressable>
    <Pressable accessibilityRole="button" testID={`published-update-cancel-${session.id}`} onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Keep current version</Text></Pressable>
  </View>;
  if (review?.kind === 'access') return <View style={styles.card} testID={`published-update-access-${session.id}`}>
    <Text accessibilityRole="header" style={styles.title}>Allow changed access?</Text>
    <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{review.request.publisher}</Text>
    <Text style={styles.detail}>Napplet</Text><Text selectable style={styles.claim}>{review.request.appId}</Text>
    <Text style={styles.detail}>The update requests: {review.request.domains.length ? review.request.domains.join(', ') : 'none'}</Text>
    <Text style={styles.warning}>Unavailable: {review.request.unsupportedDomains.join(', ') || 'none'}. These capabilities will not be granted.</Text>
    <Pressable accessibilityRole="button" testID={`published-update-access-accept-${session.id}`} onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Allow and update</Text></Pressable>
    <Pressable accessibilityRole="button" testID={`published-update-access-cancel-${session.id}`} onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Keep current version</Text></Pressable>
  </View>;
  return <View style={styles.card}>
    <Text style={styles.title}>{session.title}</Text>
    <Text selectable style={styles.claim}>Pinned event {session.eventId}</Text>
    <PublishedCapabilityDetails session={session} />
    {status !== '' && <Text accessibilityLiveRegion="polite" style={styles.detail}>{status}</Text>}
    <Pressable accessibilityRole="button" testID={`published-update-check-${session.id}`} disabled={busy} accessibilityState={{ disabled: busy }} onPress={start} style={styles.secondary}>
      {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.secondaryText}>Check for update</Text>}
    </Pressable>
  </View>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  card: { gap: 12, padding: 18, borderWidth: 1, borderColor: colors.border, borderRadius: 0, backgroundColor: colors.surface },
  title: { fontFamily: fonts.strong, color: colors.text, fontSize: 18, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 22 },
  claim: { fontFamily: fonts.mono, color: colors.text, fontSize: 12 },
  warning: { fontFamily: fonts.body, color: colors.text, fontSize: 15, lineHeight: 22 },
  action: { padding: 18, minHeight: 56, borderRadius: 0, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  actionText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  secondary: { padding: 18, minHeight: 56, borderRadius: 0, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
});
