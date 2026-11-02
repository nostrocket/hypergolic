import { TrustedBand } from './TrustedBand';
import {useEffect, useSyncExternalStore} from 'react';
import {AppState, Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {IdentityListAccess, IdentityListAccessSnapshot} from '../identity/identity-permissions';
import {formatNpub} from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
const empty: IdentityListAccessSnapshot = Object.freeze({grants: [], denied: [], review: null, busy: false, error: null});
const subscribe = () => () => {}, getEmpty = () => empty;
export function IdentityListReview({service, blocked = false}: {service: IdentityListAccess | null; blocked?: boolean}) {
  const { styles } = useShellStyles(createStyles);
  const state = useSyncExternalStore(service?.subscribe ?? subscribe, service?.getSnapshot ?? getEmpty);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {if (next !== 'active') service?.dismissPending();});
    return () => subscription.remove();
  }, [service]);
  useEffect(() => {if (blocked) service?.dismissPending();}, [service, blocked]);
  if (!service || !state.review || blocked) return null;
  const review = state.review, disabled = state.busy;
  const decide = (allow: boolean) => {void service.decide(review.id, allow).catch(() => { /* Service publishes the current failure. */ });};
  return <Modal visible transparent animationType="none" onRequestClose={() => {if (!disabled) decide(false);}}>
    <View style={styles.backdrop}><View testID="identity-list-review" accessibilityViewIsModal style={[styles.sheet, {paddingBottom: Math.max(16, insets.bottom)}]}>
      <TrustedBand />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Allow public list access?</Text>
        <Text style={styles.text}>This napplet wants to read your public mutes, bookmarks, pins and interests. These signed lists are already public on relays.</Text>
        <Text style={styles.label}>Requesting app</Text><Text selectable testID="identity-list-app" style={styles.text}>{review.owner.appId}</Text>
        {review.source === 'bundled' && <Text style={styles.text}>Reviewed bundled fixture</Text>}
        <Text style={styles.label}>{review.source === 'bundled' ? 'Publisher namespace' : 'Publisher'}</Text><Text selectable testID="identity-list-publisher" style={styles.mono}>{formatNpub(review.owner.publisher)}</Text>
        <Text style={styles.label}>Selected public identity</Text><Text selectable testID="identity-list-user" style={styles.mono}>{formatNpub(review.owner.user)}</Text>
        <Text style={styles.text}>Allow remembers this permission for this identity, publisher and app. You can revoke it in Settings.</Text>
        {state.error && <Text accessibilityLiveRegion="polite" style={styles.text}>{state.error}</Text>}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{disabled}} style={styles.button} onPress={() => decide(true)}><Text style={styles.action}>{disabled ? 'Saving permission…' : 'Allow public lists'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{disabled}} style={styles.button} onPress={() => decide(false)}><Text style={styles.action}>Decline public lists</Text></Pressable>
      </View>
    </View></View>
  </Modal>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({backdrop: {flex: 1, backgroundColor: colors.shade, justifyContent: 'flex-end'}, sheet: {maxHeight: '90%', backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border}, content: {gap: 12, padding: 24}, title: { fontFamily: fonts.display,color: colors.text, fontSize: 28, }, text: { fontFamily: fonts.body,color: colors.text, fontSize: 16, lineHeight: 24}, mono: { fontFamily: fonts.mono,color: colors.text, fontSize: 13, lineHeight: 20}, label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono,color: colors.muted, fontSize: 12}, actions: {paddingHorizontal: 24, gap: 8}, button: {minHeight: 48, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.border}, action: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong,color: colors.accent, fontSize: 14}});
