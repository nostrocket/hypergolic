import { TrustedBand } from './TrustedBand';
import {useCallback, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {AppState, FlatList, Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {NotifyBroker, NotificationBadge, NotificationCard, NotifyReview} from '../presentation/notify-broker';
import {formatNpub} from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
function Button({label, id, onPress}: {label: string; id: string; onPress(): void}) {
  const { styles } = useShellStyles(createStyles);return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={styles.button}><Text style={styles.action}>{label}</Text></Pressable>;}
function NotificationContent({card, service}: {card: NotificationCard; service: NotifyBroker}) {
  const { styles } = useShellStyles(createStyles);
  return <View testID={'notify-card-' + card.id} style={styles.card}>
    <Text style={styles.detail}>From {card.origin.appId}</Text><Text selectable style={styles.publisher}>{formatNpub(card.origin.publisher)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={[card.title, card.body].filter(Boolean).join("\n")} testID={'notify-click-' + card.id} onPress={() => service.interact(card.id)}><Text style={styles.title}>{card.title}</Text>{card.body !== '' && <Text style={styles.text}>{card.body}</Text>}</Pressable>
    {card.actions.map(action => <Button key={action.id} id={'notify-action-' + action.id} label={action.label} onPress={() => service.interact(card.id, action.id)}/>)}
    <Button id={'notify-dismiss-' + card.id} label="Dismiss" onPress={() => service.dismiss(card.id)}/>
  </View>;
}
function NotificationPermission({review, service}: {review: NotifyReview; service: NotifyBroker}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  return <Modal visible transparent animationType="fade" onRequestClose={() => service.decide(review.id, false)}><View style={[styles.shade, {paddingTop: insets.top}]}><View style={styles.permissionSheet} accessibilityViewIsModal><TrustedBand /><ScrollView contentContainerStyle={[styles.sheet, {paddingBottom: Math.max(insets.bottom, 24)}]}>
    <Text accessibilityRole="header" style={styles.heading}>Allow notifications?</Text>
    <Text selectable style={styles.title}>{review.origin.appId}</Text><Text selectable style={styles.publisher}>{formatNpub(review.origin.publisher)}</Text>
    <Text style={styles.detail}>Selected identity</Text><Text selectable style={styles.publisher}>{formatNpub(review.origin.user)}</Text>
    <Text style={styles.title}>{review.label}</Text><Text selectable testID="notify-review-channel" style={styles.text}>{review.channel || 'General notifications'}</Text>
    <Text style={styles.text}>Remember this notification permission for this identity, napplet and channel. Revoke it in Settings. Alerts stay inside Hypergolic and clear when the app enters the background.</Text>
    <Button id="notify-allow" label="Allow notifications" onPress={() => service.decide(review.id, true)}/><Button id="notify-deny" label="Not now" onPress={() => service.decide(review.id, false)}/>
  </ScrollView></View></View></Modal>;
}
type CentreEntry = Readonly<{kind: 'card'; card: NotificationCard}> | Readonly<{kind: 'badge'; badge: NotificationBadge}>;
export function Notifications({service, blocked}: {service: NotifyBroker; blocked: boolean}) {
  const { styles } = useShellStyles(createStyles);
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot), [opened, setOpened] = useState(false), insets = useSafeAreaInsets();
  useEffect(() => {
    const timer = setInterval(() => service.refresh(), 250), listener = AppState.addEventListener('change', state => {if (state !== 'active') setOpened(false); service.refresh();});
    return () => {clearInterval(timer); listener.remove();};
  }, [service]);
  const entries = useMemo<readonly CentreEntry[]>(() => [...snapshot.cards.map(card => ({kind: 'card' as const, card})), ...snapshot.attributedBadges.map(badge => ({kind: 'badge' as const, badge}))], [snapshot.cards, snapshot.attributedBadges]);
  const renderEntry = useCallback(({item}: {item: CentreEntry}) => item.kind === 'card' ? <NotificationContent card={item.card} service={service}/> : <View testID={'notify-badge-' + item.badge.origin.appId} style={styles.card}><Text style={styles.title}>{item.badge.origin.appId}</Text><Text style={styles.publisher}>{formatNpub(item.badge.origin.publisher)}</Text><Text style={styles.text}>Badge count: {item.badge.count}</Text></View>, [service, styles]);
  if (blocked) return null;
  const toast = !opened && !snapshot.review ? snapshot.toast : undefined;
  const badge = Object.values(snapshot.badges).reduce((sum, count) => sum + count, 0);
  return <>
    {toast && <View testID="notify-toast" style={styles.toast}><View style={styles.card}>
      <Text numberOfLines={1} style={styles.detail}>From {toast.origin.appId}</Text><Text numberOfLines={1} style={styles.publisher}>{formatNpub(toast.origin.publisher)}</Text>
      <Text numberOfLines={1} style={styles.title}>{toast.title}</Text>{toast.body !== '' && <Text numberOfLines={2} style={styles.text}>{toast.body}</Text>}
      <Button id="notify-toast-open" label="View notification" onPress={() => setOpened(true)}/>
    </View></View>}
    {(snapshot.cards.length > 0 || badge > 0) && !snapshot.review && <View style={styles.launcher}><Button id="notify-centre-open" label={'Notifications (' + snapshot.cards.length + '), badges ' + badge} onPress={() => setOpened(true)}/></View>}
    <Modal visible={opened && !snapshot.review} transparent animationType="fade" onRequestClose={() => setOpened(false)}><View style={[styles.shade, {paddingTop: insets.top}]}><FlatList
      data={entries}
      keyExtractor={item => item.kind === 'card' ? 'card-' + item.card.id : 'badge-' + item.badge.origin.generation}
      contentContainerStyle={[styles.sheet, {paddingBottom: Math.max(insets.bottom, 24)}]}
      ListHeaderComponent={<View style={styles.group}><Text accessibilityRole="header" style={styles.heading}>Notifications</Text><Button id="notify-centre-close" label="Done" onPress={() => setOpened(false)}/></View>}
      renderItem={renderEntry}
      ListEmptyComponent={<Text style={styles.detail}>No current notifications.</Text>}/></View></Modal>
    {snapshot.review && <NotificationPermission review={snapshot.review} service={service}/>}
  </>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  permissionSheet: {maxHeight: '92%', backgroundColor: colors.surface}, group: {gap: 12}, shade: {flex: 1, justifyContent: 'flex-end', backgroundColor: colors.shade}, sheet: {backgroundColor: colors.background, padding: 24, gap: 12},
  heading: { fontFamily: fonts.display,color: colors.text, fontSize: 28, }, title: { fontFamily: fonts.strong,color: colors.text, fontSize: 18, }, text: { fontFamily: fonts.body,color: colors.text, fontSize: 16, lineHeight: 24},
  detail: { fontFamily: fonts.body,color: colors.muted, fontSize: 14}, publisher: { fontFamily: fonts.mono,color: colors.muted, fontSize: 12, },
  button: {padding: 12, minHeight: 44, backgroundColor: colors.surface, borderRadius: 0}, action: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color: colors.accent, fontSize: 14},
  card: {backgroundColor: colors.surface, padding: 14, gap: 8, borderRadius: 0}, toast: {paddingHorizontal: 16, paddingTop: 8}, launcher: {paddingHorizontal: 16, paddingVertical: 8},
});
