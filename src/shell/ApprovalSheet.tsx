import { TrustedBand } from './TrustedBand';
import {OutboxReview} from './OutboxReview';
import { useRef, useState } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { formatNpub } from '../security/public-identity.ts';
import type { ApprovalItem } from '../security/approval-service.ts';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type ApprovalSheetProps = Readonly<{
  item: ApprovalItem | null;
  nappletTitle: string;
  busy: boolean;
  error: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: string) => void;
}>;

function requestedKind(kind: number): string { return kind === 1 ? 'Note' : `Event kind ${kind}`; }

function Review({ item, nappletTitle, busy, error, onApprove, onReject, onDismiss }: Omit<ApprovalSheetProps, 'item'> & { item: ApprovalItem }) {
  const { styles } = useShellStyles(createStyles);
  const approve = useRef<View>(null);
  const [details, setDetails] = useState(false);
  const insets = useSafeAreaInsets();
  const publisherNpub = formatNpub(item.origin.publisher);
  const identityNpub = formatNpub(item.event.selectedPubkey);
  const dismiss = () => { if (!busy) onDismiss(item.id); };
  return <Modal visible transparent animationType="none" onRequestClose={dismiss} onShow={() => {
    approve.current?.focus();
    if (approve.current) AccessibilityInfo.sendAccessibilityEvent(approve.current, 'focus');
  }}>
    <View style={styles.backdrop}>
      <View testID="approval-sheet" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom) }]}>
        <TrustedBand />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.eyebrow}>Approve signing request</Text>
          <Text style={styles.title}>{requestedKind(item.event.event.kind)}</Text>
          <Text testID="approval-sheet-content" selectable style={styles.content}>{item.event.event.content}</Text>
          <View style={styles.divider} />
          <Text style={styles.label}>Requesting napplet</Text>
          <Text style={styles.value}>{nappletTitle}</Text>
          <Text style={styles.label}>Publisher</Text>
          <Text testID="approval-sheet-publisher" selectable style={styles.mono}>{item.origin.publisher}{'\n'}{publisherNpub}</Text>
          <Text style={styles.label}>Selected identity</Text>
          <Text testID="approval-sheet-identity" selectable style={styles.mono}>{identityNpub}</Text>
          {item.outbox ? <OutboxReview plan={item.outbox}/> : <><Text style={styles.label}>Publish to</Text><Text selectable style={styles.destination}>{item.event.destinations.join('\n')}</Text></>}
          <Pressable testID="approval-sheet-details" accessibilityRole="button" accessibilityState={{ expanded: details, disabled: busy }} disabled={busy} onPress={() => setDetails(value => !value)} style={({ pressed }) => [styles.details, pressed && styles.pressed]}>
            <Text style={styles.detailsText}>{details ? 'Hide exact event' : 'Show exact event'}</Text>
          </Pressable>
          {details && <Text selectable style={styles.json}>{JSON.stringify({ event: item.event.event, hash: item.event.hash }, null, 2)}</Text>}
          {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        </ScrollView>
        <View style={styles.actions}>
          <Pressable ref={approve} testID="approval-sheet-approve" accessibilityRole="button" accessibilityLabel="Approve once" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => onApprove(item.id)} style={({ pressed }) => [styles.approve, (pressed || busy) && styles.pressed]}><Text style={styles.approveText}>{busy ? 'Signing and publishing…' : 'Approve once'}</Text></Pressable>
          <Pressable testID="approval-sheet-reject" accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => onReject(item.id)} style={({ pressed }) => [styles.reject, (pressed || busy) && styles.pressed]}><Text style={styles.rejectText}>Reject</Text></Pressable>
          <Pressable testID="approval-sheet-dismiss" accessibilityRole="button" accessibilityLabel="Dismiss signing request" accessibilityState={{ disabled: busy }} disabled={busy} onPress={dismiss} style={({ pressed }) => [styles.dismiss, (pressed || busy) && styles.pressed]}><Text style={styles.dismissText}>Dismiss</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

/** Trusted presentation only; approval authority, signing, and publication remain outside this sheet. */
export function ApprovalSheet(props: ApprovalSheetProps) {
  return props.item === null ? null : <Review key={props.item.id} {...props} item={props.item} />;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.shade, justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border, borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  scroll: { gap: 10, padding: 24 },
  eyebrow: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono, color: colors.accent, fontSize: 12, },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 28, letterSpacing: 0.2 },
  content: { fontFamily: fonts.body, color: colors.text, fontSize: 17, lineHeight: 25 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono, color: colors.muted, fontSize: 12, marginTop: 8 },
  value: { fontFamily: fonts.body, color: colors.text, fontSize: 17, lineHeight: 25 },
  mono: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20 },
  destination: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20 },
  details: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 8 },
  detailsText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.accent, fontSize: 14, },
  json: { fontFamily: fonts.mono, color: colors.muted, fontSize: 12, lineHeight: 18 },
  error: { fontFamily: fonts.body, color: colors.accent, fontSize: 16, lineHeight: 24 },
  actions: { gap: 10, padding: 24, paddingTop: 0, borderTopWidth: 1, borderColor: colors.border },
  approve: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 0, backgroundColor: colors.primary, padding: 12 },
  approveText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  reject: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 0, borderWidth: 1, borderColor: colors.border, padding: 12 },
  rejectText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14, },
  dismiss: { minHeight: 48, alignItems: 'center', justifyContent: 'center', padding: 12 },
  dismissText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.muted, fontSize: 14 },
  pressed: { opacity: 0.65 },
});
