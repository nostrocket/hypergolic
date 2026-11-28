import {memo, useCallback, useState} from 'react';
import {requireNativeModule} from 'expo';
import {FlatList, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ListRenderItemInfo} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {redactedSummary, type DiagnosticEntry} from '../runtime/napplet-diagnostics';
import {RelaySettings} from './RelaySettings';
import {SettingsKeyboardViewport} from './SettingsKeyboardViewport';
import type {RelaySettingsService} from '../network/relay-settings';
import type {NappletDescriptor} from './workspace';
import {ShellModal} from './ShellModal';
import {ShellPressable} from './ShellPressable';
import {useShellStyles, type ShellPalette, type ShellFonts} from './theme';

interface Props {
  session: NappletDescriptor;
  rows: DiagnosticEntry[];
  relays?: RelaySettingsService | null;
  close(): void;
}
export function NappletDiagnostics({session, rows, relays, close}: Props) {
  const {styles} = useShellStyles(createStyles);
  const {width, height} = useWindowDimensions();
  const [selected, select] = useState(() => [...rows].reverse().find(row => row.networkSettings) ?? rows[rows.length - 1]);
  const [network, showNetwork] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy redacted summary');
  const copy = async () => {
    try { await requireNativeModule<{copyDiagnostics(text: string): Promise<void>}>('HypergolicNappletHost').copyDiagnostics(redactedSummary(rows)); setCopyLabel('Summary copied'); }
    catch { setCopyLabel('Copy failed · retry'); }
  };
  const renderRow = useCallback(({item}: ListRenderItemInfo<DiagnosticEntry>) =>
    <DiagnosticRow row={item} selected={item.id === selected?.id} select={select} />, [selected?.id]);
  const dismiss = () => network ? showNetwork(false) : close();
  return <ShellModal visible onRequestClose={dismiss}>
    <SafeAreaProvider><SafeAreaView style={[styles.screen, network && styles.networkScreen]} onAccessibilityEscape={dismiss}>
      {network ? <SettingsKeyboardViewport><RelaySettings service={relays ?? null} onBack={dismiss} /></SettingsKeyboardViewport> : <>
      <View style={styles.header}>
        <View style={styles.heading}><Text style={styles.label} numberOfLines={1}>{session.title}</Text>
          <Text accessibilityRole="header" style={styles.title}>Diagnostics</Text></View>
        <ShellPressable accessibilityRole="button" onPress={dismiss} style={styles.action}><Text style={styles.link}>Done</Text></ShellPressable>
      </View>
        <View style={[styles.panes, width > height && styles.wide]}>
          <View style={styles.timeline}><Text style={styles.label}>Host timeline</Text>
            <FlatList data={rows} keyExtractor={row => String(row.id)} renderItem={renderRow} /></View>
          <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent}>
            <Text style={styles.label}>Event detail</Text><Text style={styles.subtitle}>{selected?.title ?? 'No host events available'}</Text>
            <Text selectable style={styles.text}>{selected?.detail || 'This snapshot contains events from the current published document while its host is mounted.'}</Text>
            {selected?.hostname && <Text selectable style={styles.link}>{selected.hostname}</Text>}
            {selected?.networkSettings && relays && <ShellPressable accessibilityRole="button" onPress={() => showNetwork(true)} style={styles.action}><Text style={styles.link}>View Network settings ›</Text></ShellPressable>}
            <Text style={styles.label}>Pinned publication</Text><Text selectable style={styles.time}>{session.eventId}</Text>
            <Text style={styles.label}>Instance</Text><Text selectable style={styles.time}>{session.id}</Text>
          </ScrollView>
        </View>
        <ShellPressable accessibilityRole="button" disabled={!rows.length} style={styles.action} onPress={copy}>
          <Text accessibilityLiveRegion="polite" style={styles.link}>{copyLabel}</Text>
        </ShellPressable>
      </>}
    </SafeAreaView></SafeAreaProvider>
  </ShellModal>;
}
const DiagnosticRow = memo(function DiagnosticRow({row, selected, select}: {row: DiagnosticEntry; selected: boolean; select(row: DiagnosticEntry): void}) {
  const {styles} = useShellStyles(createStyles);
  return <ShellPressable accessibilityRole="button" accessibilityState={{selected: selected}}
              onPress={() => select(row)} style={[styles.row, selected && styles.selected]}>
              <Text style={styles.time}>+{(row.elapsed / 1000).toFixed(2)} s</Text><Text style={styles.text}>{row.title}</Text>
            </ShellPressable>;
});
const createStyles = (c: ShellPalette, f: ShellFonts) => StyleSheet.create({
  screen: {flex: 1, paddingHorizontal: 16, backgroundColor: c.background},
  networkScreen: {paddingHorizontal: 0},
  header: {flexDirection: 'row', alignItems: 'center', paddingVertical: 6},
  heading: {flex: 1},
  title: {fontFamily: f.display, fontSize: 25, color: c.text},
  subtitle: {fontFamily: f.medium, fontSize: 20, color: c.text},
  label: {fontFamily: f.medium, fontSize: 13, color: c.muted},
  text: {fontFamily: f.body, color: c.text, fontSize: 15},
  link: {fontFamily: f.medium, color: c.accent, fontSize: 16},
  time: {fontFamily: f.mono, fontSize: 12, color: c.muted},
  panes: {flex: 1, gap: 12},
  wide: {flexDirection: 'row'},
  timeline: {flex: 1, gap: 6},
  row: {minHeight: 44, padding: 8, borderLeftWidth: 2, borderColor: c.subtle},
  selected: {backgroundColor: c.surface, borderColor: c.accent},
  detail: {flex: 1, backgroundColor: c.surface},
  detailContent: {padding: 14, gap: 9},
  action: {minHeight: 46, justifyContent: 'center', paddingHorizontal: 8},
});
