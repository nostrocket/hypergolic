import { MEDIA_ACCESS_DETAIL } from '../runtime/support-report';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { SettingsActions } from './Shell';
import type { NappletDescriptor } from './workspace';
import { publishedCapabilityCompatibility, type NappletConsentReview } from '../napplets/first-open-consent';
import type { PublishedUpdateReview } from '../napplets/published-session';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { useIdentityOwner } from './IdentityOwnerContext';

type Review = { kind: 'update'; request: PublishedUpdateReview } | { kind: 'access'; request: NappletConsentReview };

function PublishedCapabilityDetails({session}: {session: NappletDescriptor}) {
  const { styles } = useShellStyles(createStyles);
  const {runtime} = useIdentityOwner();
  let requested: ReturnType<NonNullable<typeof runtime>['publishedCapabilities']> = null;
  try { requested = runtime?.publishedCapabilities(session) ?? null; } catch { /* Closed or stale sessions have no live claims. */ }
  if (!requested) return null;
  const {requiredDomains, optionalDomains} = requested;
  const {unsupportedDomains, unsupportedOptionalDomains} = publishedCapabilityCompatibility(requiredDomains, optionalDomains);
  return <View>
    <Text testID={`published-capabilities-${session.id}`} style={styles.detail}>Required · {requiredDomains.join(', ') || 'none'}</Text>
    {optionalDomains.length > 0 && <Text style={styles.detail}>Optional · {optionalDomains.join(', ')}</Text>}
    {unsupportedDomains.length > 0 && <Text style={styles.warning}>Required capabilities unavailable · {unsupportedDomains.join(', ')}</Text>}
    {unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Optional capabilities unavailable · {unsupportedOptionalDomains.join(', ')}</Text>}
  </View>;
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
  const decision = useRef<{review: Review; resolve(accepted: boolean): void} | null>(null);
  useEffect(() => () => { pending.current?.abort(); decision.current?.resolve(false); decision.current = null; }, []);
  const decide = (accepted: boolean) => {
    const selected = decision.current;
    if (!selected || selected.review !== review) return;
    decision.current = null;
    selected.resolve(accepted);
    setReview(null);
  };
  const requestDecision = (next: Review, controller: AbortController) => new Promise<boolean>(resolve => {
    if (controller.signal.aborted) { resolve(false); return; }
    decision.current = {review: next, resolve};
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
  if (review?.kind === 'update') return <UpdateVersionReview sessionId={session.id} request={review.request} decide={decide} />;
  if (review?.kind === 'access') return <UpdateAccessReview sessionId={session.id} request={review.request} decide={decide} />;
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

function UpdateVersionReview({sessionId, request, decide}: {
  sessionId: string; request: PublishedUpdateReview; decide(accepted: boolean): void;
}) {
  const { styles } = useShellStyles(createStyles);
  const updateSupport = publishedCapabilityCompatibility(request.domains, request.optionalDomains);
  return <View style={styles.card} testID={`published-update-review-${sessionId}`}>
    <Text accessibilityRole="header" style={styles.title}>Use this verified update?</Text>
    <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{request.publisher}</Text>
    <Text style={styles.detail}>Napplet</Text><Text selectable style={styles.claim}>{request.appId}</Text>
    <Text style={styles.detail}>Current event</Text><Text selectable style={styles.claim}>{request.previousEventId}</Text>
    <Text style={styles.detail}>New event</Text><Text selectable style={styles.claim}>{request.nextEventId}</Text>
    {(request.domains.includes('resource') || request.optionalDomains.includes('resource')) && <Text style={styles.detail}>Resource access allows bounded public HTTPS downloads and your configured Blossom servers, retained in memory while loaded.</Text>}
    {(request.domains.includes('media') || request.optionalDomains.includes('media')) && <Text style={styles.detail}>{MEDIA_ACCESS_DETAIL}</Text>}
    <Text style={styles.detail}>{request.optionalDomains.length ? 'Required access · ' : 'Requested access: '}{request.domains.join(', ') || 'none'}</Text>
    {request.optionalDomains.length > 0 && <Text style={styles.detail}>Optional access · {request.optionalDomains.join(', ')}</Text>}
    {updateSupport.unsupportedDomains.length > 0 && <Text style={styles.warning}>Required capabilities unavailable · {updateSupport.unsupportedDomains.join(', ')}. The napplet can open with limited features.</Text>}
    {updateSupport.unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Optional capabilities unavailable · {updateSupport.unsupportedOptionalDomains.join(', ')}</Text>}
    <Text style={styles.warning}>The current napplet will close. Unsaved changes and pending signing requests will be lost; saved napplet data stays available.</Text>
    <Pressable accessibilityRole="button" testID={`published-update-accept-${sessionId}`} onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Close and use update</Text></Pressable>
    <Pressable accessibilityRole="button" testID={`published-update-cancel-${sessionId}`} onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Keep current version</Text></Pressable>
  </View>;
}

function UpdateAccessReview({sessionId, request, decide}: {
  sessionId: string; request: NappletConsentReview; decide(accepted: boolean): void;
}) {
  const { styles } = useShellStyles(createStyles);
  return <View style={styles.card} testID={`published-update-access-${sessionId}`}>
    <Text accessibilityRole="header" style={styles.title}>Allow changed access?</Text>
    <Text style={styles.detail}>Publisher</Text><Text selectable style={styles.claim}>{request.publisher}</Text>
    <Text style={styles.detail}>Napplet</Text><Text selectable style={styles.claim}>{request.appId}</Text>
    <Text style={styles.detail}>{request.optionalDomains.length ? 'Required access · ' : 'The update requests: '}{request.domains.join(', ') || 'none'}</Text>
    {request.optionalDomains.length > 0 && <Text style={styles.detail}>Optional access · {request.optionalDomains.join(', ')}</Text>}
    {(request.domains.includes('keys') || request.optionalDomains.includes('keys')) &&
      <Text style={styles.detail}>Keys lets this napplet use hardware shortcuts while it has focus.</Text>}
    {(request.domains.includes('media') || request.optionalDomains.includes('media')) && <Text style={styles.detail}>{MEDIA_ACCESS_DETAIL}</Text>}
    {request.unsupportedDomains.length > 0 && <Text style={styles.warning}>Required capabilities unavailable · {request.unsupportedDomains.join(', ')}</Text>}
    {request.unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Optional capabilities unavailable · {request.unsupportedOptionalDomains.join(', ')}</Text>}
    <Pressable accessibilityRole="button" testID={`published-update-access-accept-${sessionId}`} onPress={() => decide(true)} style={styles.action}><Text style={styles.actionText}>Allow and update</Text></Pressable>
    <Pressable accessibilityRole="button" testID={`published-update-access-cancel-${sessionId}`} onPress={() => decide(false)} style={styles.secondary}><Text style={styles.secondaryText}>Keep current version</Text></Pressable>
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
