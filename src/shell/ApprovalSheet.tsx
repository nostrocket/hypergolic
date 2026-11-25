import {reviewTextPage} from './review-text-page';
import {useReviewControl} from './useReviewControl';
import { TrustedBand } from './TrustedBand';
import {OutboxReview} from './OutboxReview';
import { useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle, type ViewInstance } from 'react-native';
import { ShellModal as Modal } from './ShellModal';
import { ShellPressable as Pressable } from './ShellPressable';
import { formatNpub } from '../security/public-identity.ts';
import {snapshotEventId} from '../napplets/published-identity';
import { requiresNewFollowListConfirmation, type ApprovalItem } from '../security/approval-service.ts';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type ApprovalSheetProps = Readonly<{
  item: ApprovalItem | null;
  nappletTitle: string;
  busy: boolean;
  error: string | null;
  onApprove: (id: string, confirmedNewListId?: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: string) => void;
}>;

const eventKinds = new Map([
  [0, 'Replace your public profile'], [1, 'Publish a note'], [3, 'Replace your follow list'],
  [5, 'Request event deletion'], [10002, 'Replace your public relay list'],
]);

function commonAction(common:NonNullable<ApprovalItem['common']>):string{
  const request=common.request;
  if(request.type==='common.follow')return 'Follow people';
  if(request.type==='common.unfollow')return 'Unfollow people';
  if(request.type==='common.react')return 'React to event';
  return request.target.type==='event'?'Report event':'Report account';
}

function commonTargets(common:NonNullable<ApprovalItem['common']>):string{
  const request=common.request;
  if(request.type==='common.follow'||request.type==='common.unfollow')return [...new Set(request.pubkeys)].join('\n');
  const rows:string[]=[];
  if(request.type==='common.react')rows.push('Event: '+request.targetEventId);
  else if(request.target.type==='pubkey')rows.push('Public key: '+request.target.pubkey);
  else rows.push('Event: '+request.target.id);
  if(common.target)rows.push('Author: '+common.target.pubkey);
  return rows.join('\n');
}

function requestedAction(item: ApprovalItem): string {
  if (item.recommendation) return 'Recommend publicly';
  if (item.appData) {
    const body = item.appData.record.body;
    if (body.deleted) return 'Unpublish public record';
    return body.previous ? 'Update public record' : 'Publish public record';
  }
  return item.common ? commonAction(item.common) : eventKinds.get(item.event.event.kind) ?? `Event kind ${item.event.event.kind}`;
}

function AppDataRecordReview({record, content}: {record: NonNullable<ApprovalItem['appData']>['record']; content: string}) {
  const { styles } = useShellStyles(createStyles);
  return <View testID="app-data-approval-record" style={styles.record}>
    <Text style={styles.label}>Record title</Text><Text selectable style={styles.value}>{record.body.title}</Text>
    <Text style={styles.value}>{record.body.deleted
      ? 'This publishes a public deletion marker. Older copies and linked files may remain available.'
      : 'Anyone may read and copy this record, including its links.'}</Text>
    <Text style={styles.label}>Record format</Text><Text selectable style={styles.mono}>{record.body.schema} · version {record.body.version}</Text>
    <Text style={styles.label}>Collection / record ID</Text><Text selectable style={styles.mono}>{record.collection} / {record.id}</Text>
    <Text style={styles.value}>{new TextEncoder().encode(content).byteLength} bytes · All listed relays must accept this change.</Text>
    <Text style={styles.label}>Exact record content</Text>
  </View>;
}

function ReviewText({text, style, testID}: {text: string; style: StyleProp<TextStyle>; testID?: string}) {
  const { styles } = useShellStyles(createStyles);
  const [page, setPage] = useState(0);
  const current = reviewTextPage(text, page);
  return <View>
    {current.count > 1 && <View style={styles.pageControls}>
      <Pressable accessibilityRole="button" disabled={current.index === 0} onPress={() => setPage(current.index - 1)} style={styles.details}>
        <Text style={styles.detailsText}>Previous page</Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={styles.value}>Page {current.index + 1} of {current.count}</Text>
      <Pressable accessibilityRole="button" disabled={current.index + 1 === current.count} onPress={() => setPage(current.index + 1)} style={styles.details}>
        <Text style={styles.detailsText}>Next page</Text>
      </Pressable>
    </View>}
    <Text testID={testID} selectable style={style}>{current.text}</Text>
  </View>;
}

function NewFollowListConsent({confirmed, busy, onChange}: {confirmed: boolean; busy: boolean; onChange(): void}) {
  const {styles} = useShellStyles(createStyles);
  return <View style={styles.record}>
    <Text accessibilityRole="header" style={styles.title}>Create a new follow list?</Text>
    <Text style={styles.value}>Your configured relays returned no follow list. Publishing this list may replace an existing one held by other relays.</Text>
    <Pressable accessibilityRole="checkbox" accessibilityState={{checked: confirmed}} disabled={busy}
      testID="confirm-new-follow-list" onPress={onChange} style={styles.details}>
      <Text style={styles.detailsText}>{confirmed ? '✓ ' : '□ '}Create a list using only the accounts shown here</Text>
    </Pressable>
  </View>;
}

function RecommendationDetails({item}: {item: ApprovalItem}) {
  const {styles} = useShellStyles(createStyles);
  return <><Text style={styles.value}>{item.recommendationExcludedRelays
            ? 'Add this napplet to your public list on the reachable Network relays for this request only.'
            : 'Add this napplet to your public list on the selected Network relays.'}</Text>
            <Text selectable style={styles.mono}>{item.recommendation}</Text>
            {item.recommendationExcludedRelays && <View testID="approval-recommendation-limited" style={styles.record}>
              <Text style={styles.value}>The excluded relays could hold a newer list. This replacement may miss changes that were not returned by the reachable relays.</Text>
              <Text style={styles.value}>This approval applies only to this publication. Your Network relay settings stay unchanged.</Text>
              <Text style={styles.label}>Excluded from this publication</Text>
              <Text testID="approval-recommendation-excluded" selectable style={styles.destination}>{item.recommendationExcludedRelays.join('\n')}</Text>
            </View>}</>;
}

function ReviewActions({approveDisabled, approve, busy, reject, rejectItem, dismiss, landscape, stacked}: {
  approveDisabled: boolean; approve(): void; busy: boolean; reject: React.RefObject<ViewInstance | null>;
  rejectItem(): void; dismiss(): void; landscape: boolean; stacked: boolean;
}) {
  const {styles} = useShellStyles(createStyles);
  return <View style={[styles.actions, landscape && styles.actionsLandscape]}>
    <Pressable testID="approval-sheet-approve" accessibilityRole="button" accessibilityLabel="Continue to signer"
      accessibilityState={{disabled: approveDisabled}} disabled={approveDisabled} onPress={approve}
      style={({pressed}) => [styles.approve, landscape && styles.actionLandscape, (pressed || approveDisabled) && styles.pressed]}>
      <Text style={styles.approveText}>{busy ? 'Signing and publishing…' : 'Continue to signer'}</Text>
    </Pressable>
    <View style={[styles.secondaryActions, landscape && styles.secondaryLandscape, stacked && styles.stacked]}>
      <Pressable ref={reject} testID="approval-sheet-reject" accessibilityRole="button"
        accessibilityState={{disabled: busy}} disabled={busy} onPress={rejectItem}
        style={({pressed}) => [styles.reject, !stacked && styles.secondaryAction, (pressed || busy) && styles.pressed]}>
        <Text style={styles.rejectText}>Reject</Text>
      </Pressable>
      <Pressable testID="approval-sheet-dismiss" accessibilityRole="button" accessibilityLabel="Dismiss signing request"
        accessibilityState={{disabled: busy}} disabled={busy} onPress={dismiss}
        style={({pressed}) => [styles.dismiss, !stacked && styles.secondaryAction, (pressed || busy) && styles.pressed]}>
        <Text style={styles.dismissText}>Dismiss</Text>
      </Pressable>
    </View>
  </View>;
}

function SigningRoute({item}: {item: ApprovalItem}) {
  const {styles} = useShellStyles(createStyles);
  return <View style={styles.route}>
    <Text style={styles.label}>Your signing identity</Text>
    <Text testID="approval-sheet-identity" selectable style={styles.mono}>{formatNpub(item.event.selectedPubkey)}</Text>
    <View style={styles.divider} />
    {item.outbox ? <OutboxReview plan={item.outbox}/> : <>
      <Text style={styles.label}>{item.recommendationExcludedRelays ? 'Publish to reachable relays' : 'Publish to'}</Text>
      <Text testID="approval-sheet-destinations" selectable style={styles.destination}>{item.event.destinations.join('\n')}</Text>
    </>}
  </View>;
}

function EventReview({item, busy, confirmedNewList, onToggleNewList}: {
  item: ApprovalItem; busy: boolean; confirmedNewList: boolean; onToggleNewList(): void;
}) {
  const {styles} = useShellStyles(createStyles);
  const record = item.appData?.record;
  return <View style={styles.record}>
    <Text style={styles.label}>Event content</Text>
    {item.recommendation && <RecommendationDetails item={item}/>}
    {record && <AppDataRecordReview record={record} content={item.event.event.content}/>}
    {requiresNewFollowListConfirmation(item) && <NewFollowListConsent confirmed={confirmedNewList} busy={busy} onChange={onToggleNewList}/>}
    {item.common && <><Text style={styles.label}>Targets</Text><Text selectable style={styles.mono}>{commonTargets(item.common)}</Text></>}
    {item.common?.request.type==='common.report'&&<><Text style={styles.label}>Report reason</Text><Text style={styles.value}>{item.common.request.reason}</Text></>}
    <ReviewText testID="approval-sheet-content" style={styles.content} text={item.event.event.content}/>
  </View>;
}

function Review({ item, nappletTitle, busy, error, onApprove, onReject, onDismiss }: Omit<ApprovalSheetProps, 'item'> & { item: ApprovalItem }) {
  const { styles } = useShellStyles(createStyles);
  const control = useReviewControl(item.id);
  const reject = useRef<ViewInstance>(null);
  const [details, setDetails] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.4;
  const landscape = width > height;
  const publisherNpub = formatNpub(item.origin.publisher);
  const manifestEventId = snapshotEventId(item.origin.appId);
  const [confirmedNewList, setConfirmedNewList] = useState(false);
  const needsNewList = requiresNewFollowListConfirmation(item);
  const approveDisabled = busy || !control.ready || (needsNewList && !confirmedNewList);
  const dismiss = () => { if (!busy) onDismiss(item.id); };
  const actions = <ReviewActions approveDisabled={approveDisabled} approve={() => onApprove(item.id, confirmedNewList ? item.id : undefined)}
          busy={busy} reject={reject} rejectItem={() => onReject(item.id)} dismiss={dismiss} landscape={landscape && !stacked} stacked={stacked}/>;
  return <Modal visible transparent animationType="none" onRequestClose={dismiss} onShow={() => {
    control.onShow();
    reject.current?.focus();
    if (reject.current) AccessibilityInfo.sendAccessibilityEvent(reject.current, 'focus');
  }}>
    <View style={[styles.backdrop, {paddingLeft: insets.left, paddingRight: insets.right}]}>
      <View testID="approval-sheet" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom) }]}>
        <TrustedBand label="Signing request" />
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>{requestedAction(item)}</Text>
            <Text style={styles.requester}>Requested by <Text style={styles.source}>{nappletTitle}</Text></Text>
          </View>
          <SigningRoute item={item}/>
          <EventReview item={item} busy={busy} confirmedNewList={confirmedNewList}
            onToggleNewList={() => setConfirmedNewList(value => !value)}/>
          <View style={styles.divider} />
          <Text style={styles.metadata}>Kind {item.event.event.kind} · {item.event.event.tags.length} tags</Text>
          <Text style={styles.metadata}>Event time · {new Date(item.event.event.created_at * 1000).toISOString()}</Text>
          {manifestEventId && <><Text style={styles.label}>Snapshot (kind 5129)</Text><Text selectable style={styles.mono}>{manifestEventId}</Text></>}
          <Text style={styles.label}>Napplet publisher</Text>
          <Text testID="approval-sheet-publisher" selectable style={styles.mono}>{item.origin.publisher}{'\n'}{publisherNpub}</Text>
          <Pressable testID="approval-sheet-details" accessibilityRole="button" accessibilityState={{ expanded: details, disabled: busy }} disabled={busy} onPress={() => setDetails(value => !value)} style={({ pressed }) => [styles.details, pressed && styles.pressed]}>
            <Text style={styles.detailsText}>{details ? 'Hide exact event' : 'Show exact event'}</Text>
          </Pressable>
          {details && <ReviewText style={styles.json} text={JSON.stringify({ event: item.event.event, hash: item.event.hash }, null, 2)}/>}
          {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
          {stacked && actions}
        </ScrollView>
        {!stacked && actions}
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
  scroll: { gap: 12, padding: 20 },
  heading: { gap: 4 },
  requester: { fontFamily: fonts.body, fontSize: 16, color: colors.muted },
  source: { fontFamily: fonts.strong, color: colors.text },
  route: { backgroundColor: colors.raised, padding: 14, gap: 6, borderLeftWidth: 2, borderColor: colors.accent },
  metadata: { fontFamily: fonts.body, color: colors.muted, fontSize: 14 },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 32, letterSpacing: 0.2 },
  content: { fontFamily: fonts.body, color: colors.text, fontSize: 17, lineHeight: 25 },
  record: { gap: 10 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 2 },
  label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono, color: colors.muted, fontSize: 12 },
  value: { fontFamily: fonts.body, color: colors.text, fontSize: 17, lineHeight: 25 },
  mono: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20 },
  destination: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20 },
  pageControls: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8},
  details: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 8 },
  detailsText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.accent, fontSize: 14, },
  json: { fontFamily: fonts.mono, color: colors.muted, fontSize: 12, lineHeight: 18 },
  error: { fontFamily: fonts.body, color: colors.accent, fontSize: 16, lineHeight: 24 },
  secondaryActions: { flexDirection: 'row', gap: 8 },
  secondaryAction: { flex: 1 },
  stacked: { flexDirection: 'column' },
  secondaryLandscape: { flex: 2 },
  actions: { gap: 6, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border },
  actionsLandscape: { flexDirection: 'row', paddingVertical: 8 },
  actionLandscape: { flex: 1 },
  approve: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 0, backgroundColor: colors.primary, padding: 12 },
  approveText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 14, },
  reject: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 0, borderWidth: 1, borderColor: colors.border, padding: 12 },
  rejectText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14, },
  dismiss: { minHeight: 48, alignItems: 'center', justifyContent: 'center', padding: 12 },
  dismissText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.muted, fontSize: 14 },
  pressed: { opacity: 0.65 },
});
