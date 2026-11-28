import { useCallback, useState } from 'react';
import { Alert, FlatList, Keyboard, StyleSheet, Text, useWindowDimensions, View, type ListRenderItemInfo } from 'react-native';
import {
  assertRelayCanBeAdded, normalizeRelayUrl, RelaySettingsError, type NetworkRelayMove,
  type RelayRole, type RelaySettingsService, type RelaySettingsSnapshot,
} from '../network/relay-settings';
import { SettingsComposer, SettingsField, SettingsPrimary, SettingsRoomHeader } from './SettingsRoom';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

function relayError(error: unknown): string {
  if (error instanceof RelaySettingsError) {
    if (error.code === 'INVALID_RELAY_URL') return 'Enter a valid secure WebSocket URL using wss:// and a public DNS host.';
    if (error.code === 'DUPLICATE_RELAY') return 'That relay is already in this list.';
    if (error.code === 'RELAY_LIMIT_EXCEEDED') return 'This list can contain up to 16 relays.';
  }
  return 'The app could not confirm this change. Reopen settings to check the saved relay list.';
}

function inputError(input: string, relays: readonly string[]): string {
  if (!input) return '';
  try { assertRelayCanBeAdded(relays, normalizeRelayUrl(input)); return ''; }
  catch (error) { return relayError(error); }
}

export function RelaySettings({ service, onBack }: { service: RelaySettingsService | null; onBack(): void }) {
  const { styles } = useShellStyles(createStyles);
  if (service) return <EditableRelays service={service} onBack={onBack} />;
  return <>
    <SettingsRoomHeader title="Relays" onBack={onBack} />
    <View style={styles.header}>
      <Text style={styles.detail}>Relay choices are saved on this device.</Text>
      <Text accessibilityLiveRegion="polite" testID="relay-settings-unavailable" style={styles.error}>Saved relay settings are unavailable. Identity and napplets remain usable; signing requests cannot proceed until relay storage is available.</Text>
    </View>
  </>;
}

function EditableRelays({ service, onBack }: { service: RelaySettingsService; onBack(): void }) {
  const { styles } = useShellStyles(createStyles);
  const { fontScale } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const [editing, setEditing] = useState(false);
  const [snapshot, setSnapshot] = useState<RelaySettingsSnapshot>(() => service.getSettings());
  const [role, setRole] = useState<RelayRole>('network');
  const [inputs, setInputs] = useState({ network: '', lookup: '' });
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const network = role === 'network';
  const relays = network ? snapshot.networkRelays : snapshot.lookupRelays;
  const input = inputs[role];
  const validation = inputError(input, relays);
  const error = saveError || validation;
  const compact = height > 0 && height < 320 * fontScale;
  const defaultsState = service.getCvmDefaultsState?.();

  const update = useCallback(async (action: () => Promise<RelaySettingsSnapshot>) => {
    if (busy) return false;
    setBusy(true);
    setSaveError('');
    try { setSnapshot(await action()); return true; }
    catch (reason) {
      setSnapshot(service.getSettings());
      setSaveError(relayError(reason));
      return false;
    } finally { setBusy(false); }
  }, [busy, service]);
  const edit = (value: string) => {
    setInputs(current => ({ ...current, [role]: value }));
    setSaveError('');
  };
  const add = async () => {
    if (!input || validation || busy) return;
    if (await update(() => service.addRelay(role, input))) {
      edit('');
      Keyboard.dismiss();
    }
  };
  const restore = () => {
    if (busy) return;
    Alert.alert(`Restore ${role} defaults?`, `This replaces every relay in your ${role} list on this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore defaults', style: 'destructive', onPress: () => { void update(() => service.restoreDefaults(role)); } },
    ]);
  };
  const action = { label: 'Restore defaults', testID: `relay-restore-${role}`, onPress: restore, disabled: busy };
  const renderRelay = useCallback(({item, index}: ListRenderItemInfo<string>) => <RelayRow relay={item} role={role} busy={busy}
    remove={() => { void update(() => service.removeRelay(role, item)); }}
    order={network ? {index, count: relays.length, move: direction => { void update(() => service.moveNetworkRelay(item, direction)); }} : undefined} />, [busy, network, relays.length, role, service, update]);
  const controls = <RelayControls role={role} busy={busy} shortHelp={editing && height > 0 && height < 600 * fontScale} onSelect={item => { setRole(item); setSaveError(''); }} />;
  return <View style={styles.room} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
    <SettingsRoomHeader title="Relays" onBack={onBack} action={action} />
    <View style={styles.room}>
      {!compact && controls}
      <FlatList key={role} data={relays} keyExtractor={relay => relay} style={styles.list}
        keyboardShouldPersistTaps="handled" ListHeaderComponent={<>
          {compact && controls}
          {defaultsState === 'cleared' && <Text accessibilityLiveRegion="polite" style={[styles.error, styles.items]}>Automatic relays for remote services were cleared. Check the first four Network relays.</Text>}
          {defaultsState === 'unknown' && <Text accessibilityLiveRegion="polite" style={[styles.error, styles.items]}>The app could not confirm the automatic relays for remote services.</Text>}
        </>}
        ListEmptyComponent={<Text style={[styles.detail, styles.items]}>{network ? 'No network relays. Approved signing requests cannot proceed until a network relay is added.' : 'No lookup relays. Manifest discovery will have no lookup destinations.'}</Text>}
        renderItem={renderRelay} />
      <View style={compact && styles.compactDock}>
      <SettingsComposer>
        <SettingsField accessibilityLabel={`Add ${role} relay`} testID={`relay-input-${role}`} autoCapitalize="none"
          autoCorrect={false} keyboardType="url" autoComplete="off" returnKeyType="done" submitBehavior="submit"
          onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} editable={!busy} value={input} onChangeText={edit} onSubmitEditing={() => { void add(); }} placeholder="wss://" />
        {error !== '' && <Text accessibilityLiveRegion="polite" testID="relay-settings-error" style={styles.error}>{error}</Text>}
        <SettingsPrimary label={`Add ${role} relay`} testID={`relay-add-${role}`} disabled={busy || !input || !!validation}
          onPress={() => { void add(); }} />
      </SettingsComposer>
      </View>
    </View>
  </View>;
}

function RelayControls({role, busy, shortHelp, onSelect}: {role: RelayRole; busy: boolean; shortHelp: boolean; onSelect(role: RelayRole): void}) {
  const { styles } = useShellStyles(createStyles);
  const explanation = role === 'network'
    ? 'New basic live reads use the first two Network relays.' + (shortHelp ? '' : ' Approved publishing can use the whole list.')
    : 'Lookup relays help find napplet manifests.';
  return <View style={styles.header}>
    <Text style={styles.detail}>Relay choices are saved on this device. {explanation}</Text>
    <View style={styles.segments}>
      {(['network', 'lookup'] as const).map(item => <ShellPressable key={item} accessibilityRole="tab"
        accessibilityState={{ selected: role === item }} disabled={busy} testID={`relay-role-${item}`}
        onPress={() => onSelect(item)} style={[styles.segment, role === item && styles.selectedSegment]}>
        <Text style={[styles.segmentText, role === item && styles.selectedText]}>{item === 'network' ? 'Network' : 'Lookup'}</Text>
      </ShellPressable>)}
    </View>
  </View>;
}

type RelayRowProps = {
  relay: string; role: RelayRole; busy: boolean; remove(): void;
  order: { index: number; count: number; move(direction: NetworkRelayMove): void } | undefined;
};
function RelayRow({ relay, role, busy, remove, order }: RelayRowProps) {
  const { styles } = useShellStyles(createStyles);
  return <View style={[styles.items, styles.relay]}>
    <Text selectable style={styles.url}>{relay}</Text>
    {order && order.index < 2 && <Text style={styles.caption}>Live reads</Text>}
    <View style={styles.rowActions}>
      {order && (['up', 'down'] as const).map(direction => <ShellPressable key={direction} accessibilityRole="button"
        accessibilityLabel={`Move ${relay} ${direction}`} testID={`relay-move-${direction}-${order.index}`}
        disabled={busy || (direction === 'up' ? order.index === 0 : order.index === order.count - 1)}
        onPress={() => order.move(direction)} style={styles.rowAction}>
        <Text style={styles.rowActionText}>{direction === 'up' ? 'Move up' : 'Move down'}</Text>
      </ShellPressable>)}
      <ShellPressable accessibilityRole="button" accessibilityLabel={`Remove ${relay}`} testID={`relay-remove-${role}`}
        disabled={busy} onPress={remove} style={styles.rowAction}><Text style={styles.rowActionText}>Remove</Text></ShellPressable>
    </View>
  </View>;
}

const createStyles = (c: ShellPalette, f: ShellFonts) => StyleSheet.create({
  room: { flex: 1 },
  compactDock: { maxHeight: '65%' },
  header: { paddingHorizontal: 24, paddingBottom: 8, gap: 9 },
  detail: { fontFamily: f.body, color: c.muted, fontSize: 15, lineHeight: 20 },
  segments: { flexDirection: 'row', backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.subtle, borderRadius: 5 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  selectedSegment: { backgroundColor: c.primary },
  segmentText: { fontFamily: f.medium, color: c.text, fontSize: 15 },
  selectedText: { color: c.onPrimary },
  list: { flex: 1 },
  items: { paddingHorizontal: 24 },
  relay: { paddingTop: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.subtle },
  url: { fontFamily: f.mono, color: c.text, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: f.body, color: c.muted, fontSize: 13, lineHeight: 17 },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 },
  rowAction: { justifyContent: 'center' },
  rowActionText: { fontFamily: f.medium, color: c.accent, fontSize: 15 },
  error: { fontFamily: f.body, color: c.accent, fontSize: 14, lineHeight: 19 },
});
