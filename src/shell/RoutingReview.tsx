import { MEDIA_ACCESS_DETAIL } from '../runtime/support-report';
import type { ReviewSlot } from './review-slot';
import { TrustedBand } from './TrustedBand';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ShellModal as Modal } from './ShellModal';
import { ShellPressable as Pressable } from './ShellPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CatalogHandler } from '../routing/routing-catalog';
import type { RoutingReviewItem, RoutingReviewService, RoutingReviewRequest } from '../routing/routing-review';
import { formatNpub } from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
const subscribe = () => () => {}, empty = () => null;
export function RoutingReview({service, reviewSlot, blocked = false}: {service: RoutingReviewService | null; reviewSlot?: ReviewSlot; blocked?: boolean}) {
  const item = useSyncExternalStore(service?.subscribe ?? subscribe, service?.getSnapshot ?? empty);
  const current = useSyncExternalStore(reviewSlot?.subscribe ?? subscribe, reviewSlot?.getSnapshot ?? empty);
  useEffect(() => {
    if (!service) return;
    const timer = setInterval(() => service.refresh(), 250);
    const state = AppState.addEventListener('change', next => { if (next !== 'active') service.cancelAll(); else service.refresh(); });
    return () => {clearInterval(timer); state.remove();};
  }, [service]);
  useEffect(() => { if (blocked) service?.cancelAll(); }, [blocked, service]);
  return service && item && !blocked && (!reviewSlot || current?.lane === 'routing' && current.item.id === item.id) ? <RoutingReviewSheet key={item.id} service={service} item={item} /> : null;
}
type IntentReviewRequest = Extract<RoutingReviewRequest, {kind: 'intent'}>;
function NappletIdentity({appId, publisher, fixture}: {appId: string; publisher: string; fixture: string}) {
  const { styles } = useShellStyles(createStyles);
  return <View style={styles.group}><Text selectable style={styles.text}>{appId}</Text><Text selectable style={styles.mono}>{formatNpub(publisher)}</Text>{fixture !== 'published' && <Text style={styles.detail}>Unsigned embedded test napplet</Text>}</View>;
}
function reviewTitle(request: RoutingReviewRequest): string {
  switch (request.kind) {
    case 'published-open': return 'Open this published napplet?';
    case 'intent': return request.selected ? 'Open with this napplet?' : 'Choose a handler';
    case 'topic': return 'Allow this topic?';
    case 'permissions': return 'Allow handler capabilities?';
    case 'channel': return 'Open this channel?';
  }
}
function IntentReviewDetails({request, selected, onSelect, remember, onRemember}: {request: IntentReviewRequest; selected: CatalogHandler | null; onSelect(value: CatalogHandler): void; remember: boolean; onRemember(): void}) {
  const { styles } = useShellStyles(createStyles);
  const handlers = request.selected ? [request.selected] : request.candidates;
  const payload = Object.prototype.hasOwnProperty.call(request.request, 'payload') ? JSON.stringify(request.request.payload, null, 2) : 'No payload supplied';
  return <>
    <Text style={styles.label}>Role and action</Text><Text selectable style={styles.text}>{request.request.archetype} / {request.request.action}</Text>
    <Text style={styles.label}>Payload convention</Text><Text selectable style={styles.mono}>{request.request.convention ?? 'Handler convention for this action'}</Text>
    <Text style={styles.label}>Payload shared with the selected handler</Text><Text selectable testID="routing-payload" style={styles.mono}>{payload}</Text>
    <Text style={styles.detail}>{request.newInstance ? 'Approval opens another view.' : 'A matching loaded view is reused; otherwise the saved handler opens.'} {request.request.behavior?.focus === false ? 'Your current view keeps focus.' : 'The handler receives focus.'}</Text>
    <Text style={styles.label}>Handler and publisher</Text>
    {handlers.map(handler => <Pressable key={handler.publisher + ':' + handler.appId} testID={'routing-candidate-' + handler.publisher + '-' + handler.appId} accessibilityRole="radio" accessibilityState={{selected: selected === handler}} onPress={() => onSelect(handler)} style={[styles.choice, selected === handler && styles.chosen]}>
      <Text style={styles.text}>{handler.title}</Text><Text selectable style={styles.mono}>{formatNpub(handler.publisher)}</Text><Text style={styles.detail}>{selected === handler ? 'Selected' : 'Choose this handler'}</Text>
    </Pressable>)}
    <Pressable accessibilityRole="checkbox" accessibilityState={{checked: remember}} onPress={onRemember} style={styles.button}><Text style={styles.action}>{remember ? '✓ ' : ''}Use this handler by default for {request.request.archetype}</Text></Pressable>
    <Text style={styles.detail}>A saved default still needs your approval for each dispatch. Change it in Settings.</Text>
  </>;
}
function TopicReviewDetails({request}: {request: Extract<RoutingReviewRequest, {kind: 'topic'}>}) {
  const { styles } = useShellStyles(createStyles);
  return <><Text style={styles.label}>Exact topic</Text><Text selectable style={styles.mono}>{request.topic}</Text><Text style={styles.text}>Allow messages on this topic for this loaded session. Messages arrive only while Hypergolic is in the foreground. There is no background backlog.</Text></>;
}
function ChannelReviewDetails({request}: {request: Extract<RoutingReviewRequest, {kind: 'channel'}>}) {
  const { styles } = useShellStyles(createStyles);
  return <><Text style={styles.label}>Channel peer</Text><NappletIdentity {...request.peer}/><Text style={styles.text}>These two loaded views can exchange messages until the channel closes. Backgrounding, closing a view or changing identity closes the channel. Every new channel needs approval.</Text></>;
}
function PermissionReviewDetails({request}: {request: Extract<RoutingReviewRequest, {kind: 'permissions'}>}) {
  const { styles } = useShellStyles(createStyles);
  const { consent } = request;
  return <>
    <Text style={styles.label}>Handler</Text><NappletIdentity appId={consent.appId} publisher={consent.publisher} fixture="published"/>
    <Text style={styles.label}>Required capabilities</Text><Text selectable style={styles.text}>{consent.domains.join(', ') || 'None'}</Text>
    {consent.optionalDomains.length > 0 && <><Text style={styles.label}>Optional capabilities</Text><Text selectable style={styles.text}>{consent.optionalDomains.join(', ')}</Text></>}
    {(consent.domains.includes('keys') || consent.optionalDomains.includes('keys')) &&
      <Text style={styles.detail}>Keys lets this napplet use hardware shortcuts while it has focus.</Text>}
    {(consent.domains.includes('media') || consent.optionalDomains.includes('media')) && <Text style={styles.text}>{MEDIA_ACCESS_DETAIL}</Text>}
    {consent.unsupportedDomains.length > 0 && <Text style={styles.detail}>Unavailable required capabilities: {consent.unsupportedDomains.join(', ')}.</Text>}
    {consent.unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Unavailable optional capabilities: {consent.unsupportedOptionalDomains.join(', ')}.</Text>}
    <Text style={styles.detail}>Hypergolic saves available access for this identity, publisher and app. Uploads, intent dispatch and new communication permissions still need their own approval.</Text>
  </>;
}
function PublishedOpenDetails({request}: {request: Extract<RoutingReviewRequest, {kind: 'published-open'}>}) {
  const { styles } = useShellStyles(createStyles);
  const { target } = request;
  return <>
    <Text style={styles.label}>Target napplet and publisher</Text><NappletIdentity appId={target.appId} publisher={target.publisher} fixture="published"/>
    <Text style={styles.label}>Signed revision</Text><Text selectable style={styles.mono}>{target.eventId}</Text>
    <Text style={styles.label}>Verified artifact version</Text><Text selectable style={styles.mono}>{target.version}</Text>
    <Text style={styles.label}>Required capabilities</Text><Text style={styles.text}>{target.requiredDomains.join(', ') || 'None'}</Text>
    <Text style={styles.label}>Optional capabilities</Text><Text style={styles.text}>{target.optionalDomains.join(', ') || 'None'}</Text>
    {(target.requiredDomains.includes('keys') || target.optionalDomains.includes('keys')) &&
      <Text style={styles.detail}>Keys lets this napplet use hardware shortcuts while it has focus.</Text>}
    {(target.requiredDomains.includes('media') || target.optionalDomains.includes('media')) && <Text style={styles.detail}>{MEDIA_ACCESS_DETAIL}</Text>}
    {target.unsupportedDomains.length > 0 && <Text style={styles.detail}>Unavailable required capabilities: {target.unsupportedDomains.join(', ')}. Features using these capabilities will be unavailable.</Text>}
    {target.unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Unavailable optional capabilities: {target.unsupportedOptionalDomains.join(', ')}.</Text>}
    {request.changesAccess && <Text style={styles.detail}>Hypergolic will save the available access for this publisher and napplet under your selected identity.</Text>}
  </>;
}
function ReviewDetails({request, selected, onSelect, remember, onRemember}: {request: RoutingReviewRequest; selected: CatalogHandler | null; onSelect(value: CatalogHandler): void; remember: boolean; onRemember(): void}) {
  switch (request.kind) {
    case 'published-open': return <PublishedOpenDetails request={request}/>;
    case 'intent': return <IntentReviewDetails request={request} selected={selected} onSelect={onSelect} remember={remember} onRemember={onRemember}/>;
    case 'topic': return <TopicReviewDetails request={request}/>;
    case 'channel': return <ChannelReviewDetails request={request}/>;
    case 'permissions': return <PermissionReviewDetails request={request}/>;
  }
}
const reviewActions = {'published-open': 'Open verified version', intent: 'Approve dispatch', channel: 'Open channel once', permissions: 'Allow capabilities', topic: 'Allow this topic'} as const;
function RoutingReviewSheet({service, item}: {service: RoutingReviewService; item: RoutingReviewItem}) {
  const { styles } = useShellStyles(createStyles);
  const request = item.request, insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [selected, setSelected] = useState<CatalogHandler | null>(request.kind === 'intent' ? request.selected : null);
  const [remember, setRemember] = useState(false);
  const [legacyReadOnly, setLegacyReadOnly] = useState(false);
  const cancel = () => service.decide(item.id, {allow: false});
  const accept = () => service.decide(item.id, {allow: true, ...(selected ? {selected} : {}), remember, ...(legacyReadOnly ? {legacyReadOnly: true as const} : {})});
  const disabled = request.kind === 'intent' && selected === null;
  return <Modal visible transparent animationType="none" onRequestClose={cancel}>
    <View style={[styles.backdrop, {paddingLeft: insets.left, paddingRight: insets.right}]}><View accessibilityViewIsModal testID="routing-review" style={[styles.sheet, {paddingBottom: Math.max(16, insets.bottom)}]}>
      <TrustedBand />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{reviewTitle(request)}</Text>
        <Text style={styles.label}>Requesting napplet</Text>
        {request.kind === 'published-open' && request.source.source === 'bundled'
          ? <Text style={styles.text}>{request.source.title} · built into Hypergolic</Text>
          : <NappletIdentity {...request.origin}/>}
        <ReviewDetails request={request} selected={selected} onSelect={setSelected} remember={remember} onRemember={() => setRemember(value => !value)}/>
      </ScrollView>
      {request.kind === 'published-open' && request.legacyReadOnlyAvailable && <View style={styles.group}>
        <Pressable testID="routing-legacy-read-only" accessibilityRole="checkbox" accessibilityState={{checked: legacyReadOnly}}
          accessibilityLabel="Use legacy read-only mode" onPress={() => setLegacyReadOnly(value => !value)} style={styles.button}>
          <Text style={styles.action}>{legacyReadOnly ? '✓ ' : '□ '}Use legacy read-only mode</Text>
        </Pressable>
        <Text style={styles.detail}>Hypergolic supplies compatibility libraries and reads public content through your configured relays. Public HTTPS images use bounded native downloads. Results may be limited. Signing, publishing and uploads are unavailable in this mode.</Text>
      </View>}
      <View style={[styles.actions, landscape && styles.actionsLandscape]}><Pressable accessibilityRole="button" testID="routing-approve" disabled={disabled} accessibilityState={{disabled}} style={[styles.button, landscape && styles.actionLandscape]} onPress={accept}><Text style={styles.action}>{legacyReadOnly ? 'Open read-only' : request.kind === 'published-open' && request.changesAccess ? 'Allow and open' : reviewActions[request.kind]}</Text></Pressable>
        <Pressable accessibilityRole="button" testID="routing-cancel" style={[styles.button, landscape && styles.actionLandscape]} onPress={cancel}><Text style={styles.action}>Cancel</Text></Pressable></View>
    </View></View>
  </Modal>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({backdrop: {flex: 1, backgroundColor: colors.shade, justifyContent: 'flex-end'}, sheet: {maxHeight: '90%', backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border, paddingTop: 0}, content: {gap: 12, padding: 24}, group: {gap: 6}, title: { fontFamily: fonts.display,fontSize: 28, color: colors.text}, label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono,fontSize: 12, color: colors.muted}, text: { fontFamily: fonts.body,fontSize: 16, lineHeight: 24, color: colors.text}, mono: { fontFamily: fonts.mono,fontSize: 13, lineHeight: 20, color: colors.text}, detail: { fontFamily: fonts.body,fontSize: 14, lineHeight: 21, color: colors.muted}, choice: {padding: 16, gap: 6, borderWidth: 1, borderColor: colors.border}, chosen: {borderColor: colors.accent}, actions: {paddingHorizontal: 24, gap: 8}, actionsLandscape: {flexDirection: 'row'}, actionLandscape: {flex: 1}, button: {minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'}, action: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,fontSize: 14, color: colors.accent}});
