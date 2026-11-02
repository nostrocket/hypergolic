import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { CatalogHandler, CatalogSnapshot } from '../routing/routing-catalog';
import type { RoutingSettingsService } from '../routing/routing-settings';
import { formatNpub } from '../security/public-identity';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
function Action({id, title, disabled, onPress}: {id: string; title: string; disabled: boolean; onPress(): void}) {
  const { styles } = useShellStyles(createStyles);
  return <Pressable testID={id} accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.label}>{title}</Text></Pressable>;
}
function Handler({handler, snapshot, busy, prefer, remove}: {handler: CatalogHandler; snapshot: CatalogSnapshot; busy: boolean; prefer(role: string, handler: CatalogHandler | null): void; remove(handler: CatalogHandler): void}) {
  const { styles } = useShellStyles(createStyles);
  const key = handler.publisher + '-' + handler.appId;
  return <View testID={'routing-handler-' + key} style={styles.handler}>
    <Text style={styles.title}>{handler.title}</Text><Text selectable style={styles.mono}>{formatNpub(handler.publisher)}</Text>
    {handler.roles.length === 0 && <Text style={styles.detail}>No handler roles declared.</Text>}
    {handler.roles.map(role => {
      const selected = snapshot.defaults.some(value => value.archetype === role.archetype && value.publisher === handler.publisher && value.appId === handler.appId);
      return <View key={role.archetype} style={styles.group}><Text style={styles.detail}>{role.archetype}{selected ? ' · Default handler' : ''}</Text>
        <Action id={'routing-default-' + role.archetype + '-' + key} title={selected ? 'Clear default for ' + role.archetype : 'Use by default for ' + role.archetype} disabled={busy} onPress={() => prefer(role.archetype, selected ? null : handler)} />
      </View>;
    })}
    <Action id={'routing-remove-' + key} title={'Remove registration for ' + handler.title} disabled={busy} onPress={() => remove(handler)} />
  </View>;
}
export function RoutingSettings({service}: {service: RoutingSettingsService}) {
  const { styles } = useShellStyles(createStyles);
  const [state, setState] = useState<{snapshot: CatalogSnapshot | null; busy: boolean; status: string}>({snapshot: null, busy: true, status: ''});
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    let mounted = true;
    function refresh() {
      pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
      void service.list({signal: controller.signal}).then(snapshot => {if (mounted && !controller.signal.aborted) setState({snapshot, busy: false, status: ''});}).catch(() => {if (mounted && !controller.signal.aborted) setState({snapshot: null, busy: false, status: 'Saved handlers are unavailable.'});});
    }
    refresh(); const subscription = AppState.addEventListener('change', next => {if (next === 'active') refresh(); else pending.current?.abort();});
    return () => {mounted = false; pending.current?.abort(); subscription.remove();};
  }, [service]);
  async function update(action: (signal: AbortSignal) => Promise<CatalogSnapshot>, status: string) {
    if (state.busy || !state.snapshot) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setState(previous => ({...previous, busy: true, status: ''}));
    try {const snapshot = await action(controller.signal); if (!controller.signal.aborted) setState({snapshot, busy: false, status});}
    catch {if (!controller.signal.aborted) setState(previous => ({...previous, busy: false, status: 'The change could not be completed. Reopen Settings to check saved handlers.'}));}
  }
  return <View style={styles.group}><Text accessibilityRole="header" style={styles.heading}>Saved handlers</Text>
    <Text style={styles.detail}>Verified napplets you have opened are saved for this identity. Defaults still need approval for every dispatch. Removing a registration also clears its defaults; saved napplet data remains. Opening it again restores its registration.</Text>
    {state.snapshot?.handlers.length === 0 && <Text testID="routing-empty" style={styles.detail}>No saved handlers for this identity.</Text>}
    {state.snapshot?.handlers.map(handler => <Handler key={handler.publisher + ':' + handler.appId} handler={handler} snapshot={state.snapshot!} busy={state.busy}
      prefer={(role, value) => {void update(signal => service.prefer(role, value, {signal}), value ? 'Default handler saved.' : 'Default cleared.');}}
      remove={value => {void update(signal => service.remove(value, {signal}), 'Registration removed. Saved data remains.');}} />)}
    {state.status !== '' && <Text testID="routing-settings-status" accessibilityLiveRegion="polite" style={styles.detail}>{state.status}</Text>}
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({group: {gap: 14}, heading: { fontFamily: fonts.display,fontSize: 28, color: colors.text}, title: { fontFamily: fonts.strong,fontSize: 17, color: colors.text}, detail: { fontFamily: fonts.body,color: colors.muted, fontSize: 15, lineHeight: 22}, mono: { fontFamily: fonts.mono,color: colors.text, fontSize: 13, lineHeight: 20, }, handler: {gap: 12, padding: 16, borderRadius: 0, borderWidth: 1, borderColor: colors.border}, button: {minHeight: 52, padding: 14, borderRadius: 0, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border}, label: { textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: fonts.mono,color: colors.text, fontSize: 12}, disabled: {opacity: 0.5}});
