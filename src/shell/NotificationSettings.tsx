import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, FlatList, Modal, StyleSheet, Text, View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type {NotificationSettingsService} from '../presentation/notify-settings';
import type {NotifyPermission} from '../presentation/notify-permissions';
import {formatNpub} from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
function PermissionRow({permission, busy, revoke}: {permission: NotifyPermission; busy: boolean; revoke(permission: NotifyPermission): void}) {
  const { styles } = useShellStyles(createStyles);
  const press = useCallback(() => revoke(permission), [permission, revoke]);
  return <View style={styles.permission}><Text style={styles.title}>{permission.appId}</Text><Text selectable style={styles.publisher}>{formatNpub(permission.publisher)}</Text><Text style={styles.detail}>{permission.channel || 'General notifications'}</Text>
    <Pressable testID={'notify-revoke-' + permission.appId + '-' + (permission.channel || 'general')} accessibilityRole="button" disabled={busy} accessibilityState={{disabled: busy}} onPress={press} style={styles.button}><Text style={styles.action}>Revoke notification permission</Text></Pressable></View>;
}
export function NotificationSettings({service}: {service: NotificationSettingsService}) {
  const { styles } = useShellStyles(createStyles);
  const [state, setState] = useState<{rows: readonly NotifyPermission[]; busy: boolean; status: string}>({rows: [], busy: true, status: ''});
  const pending = useRef<AbortController | null>(null), [opened, setOpened] = useState(false);
  useEffect(() => {
    let mounted = true;
    function refresh() {
      pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
      void service.list({signal: controller.signal}).then(rows => {if (mounted && !controller.signal.aborted) setState({rows, busy: false, status: ''});}).catch(() => {if (mounted && !controller.signal.aborted) setState({rows: [], busy: false, status: 'Notification permissions are unavailable.'});});
    }
    refresh(); const subscription = AppState.addEventListener('change', next => {if (next === 'active') refresh(); else {pending.current?.abort(); setOpened(false);}});
    return () => {mounted = false; pending.current?.abort(); subscription.remove();};
  }, [service]);
  const revoke = useCallback(async (permission: NotifyPermission) => {
    if (state.busy || pending.current?.signal.aborted) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setState(previous => ({...previous, busy: true, status: ''}));
    try {const rows = await service.revoke(permission, {signal: controller.signal}); if (!controller.signal.aborted) setState({rows, busy: false, status: 'Notification permission revoked.'});}
    catch {if (!controller.signal.aborted) setState(previous => ({...previous, busy: false, status: 'Revocation could not be confirmed. Reopen Settings to check saved permissions.'}));}
  }, [service, state.busy]);
  const renderPermission = useCallback(({item}: {item: NotifyPermission}) => <PermissionRow permission={item} busy={state.busy} revoke={revoke}/>, [revoke, state.busy]);
  return <View style={styles.group}><Text accessibilityRole="header" style={styles.heading}>Notification permissions</Text>
    <Text style={styles.detail}>Permissions apply only to this identity, publisher, napplet and exact channel. Revoking clears its current alerts and badge. A later request needs fresh approval.</Text>
    <Pressable testID="notify-permissions-open" accessibilityRole="button" onPress={() => setOpened(true)} style={styles.button}><Text style={styles.action}>Manage notification permissions ({state.rows.length})</Text></Pressable>
    <Modal visible={opened} transparent animationType="fade" onRequestClose={() => setOpened(false)}><View style={styles.backdrop}><FlatList data={state.rows} contentContainerStyle={styles.sheet} keyExtractor={row => JSON.stringify([row.publisher, row.appId, row.channel])}
      ListHeaderComponent={<Text accessibilityRole="header" style={styles.heading}>Notification permissions</Text>}
      ListFooterComponent={<View style={styles.group}>{state.status !== '' && <Text testID="notify-settings-status" accessibilityLiveRegion="polite" style={styles.detail}>{state.status}</Text>}<Pressable testID="notify-permissions-close" accessibilityRole="button" onPress={() => setOpened(false)} style={styles.button}><Text style={styles.action}>Done</Text></Pressable></View>}
      ListEmptyComponent={!state.busy ? <Text testID="notify-permissions-empty" style={styles.detail}>No saved notification permissions for this identity.</Text> : null}
      renderItem={renderPermission}/>
    </View></Modal>
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({backdrop: {flex: 1, paddingTop: 64, backgroundColor: colors.shade}, sheet: {padding: 24, gap: 14, backgroundColor: colors.background}, group: {gap: 14}, heading: { fontFamily: fonts.display,fontSize: 28, color: colors.text}, title: { fontFamily: fonts.strong,fontSize: 17, color: colors.text}, detail: { fontFamily: fonts.body,fontSize: 15, lineHeight: 22, color: colors.muted}, publisher: { fontFamily: fonts.mono,fontSize: 13, color: colors.muted}, permission: {gap: 12, marginBottom: 16, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 0}, button: {minHeight: 48, padding: 14, backgroundColor: colors.surface, borderRadius: 0}, action: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,fontSize: 14, color: colors.accent}});
