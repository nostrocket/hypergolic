import { OwnerContext } from './IdentityOwnerContext';
import { useContext, useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ShellPressable } from './ShellPressable';
import { pinnedNapplets, pinKey } from './pins';
import type { NappletDescriptor, Workspace } from './workspace';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

function PinIcon({pin}: {pin: NappletDescriptor}) {
  const {styles} = useShellStyles(createStyles, true);
  const owner = useContext(OwnerContext);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const media = owner?.launchReviewMedia;
  useEffect(() => {
    if (!pin.icon || !media) return;
    const controller = new AbortController();
    void media.readIcon(pin.icon, controller.signal).then(value => {
      if (!controller.signal.aborted) setUri(value);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [pin.icon, media]);
  return <View style={styles.icon} accessible={false}>{pin.appId === 'napplet-discovery' && pin.source === 'bundled'
    ? <Image source={require('../../assets/brand/hypergolic-logo.png')} style={styles.spark} contentFit="contain" />
    : uri && !failed ? <Image source={{uri}} style={styles.artwork} contentFit="cover" cachePolicy="none" autoplay={false} onError={() => setFailed(true)} />
      : <Text style={styles.monogram}>{Array.from(pin.title.trim()).slice(0, 2).join('').toUpperCase()}</Text>}</View>;
}

export function Home({workspace, disabled, onOpen, onUnpin, onOverview, onDiscover}: {
  workspace: Workspace; disabled: boolean; onOpen(pin: NappletDescriptor): void;
  onUnpin(pin: NappletDescriptor): void; onOverview(): void; onDiscover(): void;
}) {
  const {styles} = useShellStyles(createStyles, true);
  const [editing, setEditing] = useState(false);
  const {fontScale} = useWindowDimensions();
  const pins = pinnedNapplets(workspace);
  return <ScrollView testID="shell-home" contentContainerStyle={styles.content}>
    <View style={styles.headingRow}><Text accessibilityRole="header" style={styles.heading}>Home</Text>
      <ShellPressable accessibilityRole="button" disabled={disabled} testID="home-overview" onPress={onOverview} style={styles.action}><Text style={styles.actionText}>All napplets</Text></ShellPressable>
    </View>
    <View style={styles.headingRow}><Text style={styles.subtitle}>Pinned napplets</Text>
      {pins.length > 0 && <ShellPressable accessibilityRole="button" accessibilityState={{expanded: editing}} disabled={disabled} testID="home-edit" onPress={() => setEditing(value => !value)} style={styles.action}><Text style={styles.actionText}>{editing ? 'Done' : 'Edit'}</Text></ShellPressable>}
    </View>
    {pins.length === 0 && <View style={styles.empty}><Text style={styles.subtitle}>Pin napplets from Discover or their menu to keep them here.</Text>
      <ShellPressable accessibilityRole="button" disabled={disabled} onPress={onDiscover} style={styles.action}><Text style={styles.actionText}>Discover napplets</Text></ShellPressable></View>}
    <View style={styles.grid}>{pins.map(pin => <View key={pinKey(pin)} style={[styles.cell, fontScale > 1.4 && styles.largeCell]}>
      <ShellPressable accessibilityRole="button" accessibilityLabel={`Open ${pin.title}`} testID={`home-pin-${pin.id}`} disabled={disabled || editing} onPress={() => onOpen(pin)} style={styles.shortcut}>
        <PinIcon key={`${pin.id}:${pin.version}`} pin={pin} />
        <Text style={styles.label}>{pin.title}</Text>
      </ShellPressable>
      {editing && <ShellPressable accessibilityRole="button" accessibilityLabel={`Unpin ${pin.title}`} disabled={disabled} testID={`home-unpin-${pin.id}`} onPress={() => onUnpin(pin)} style={styles.remove}><Text style={styles.actionText}>Unpin</Text></ShellPressable>}
    </View>)}</View>
  </ScrollView>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  content: {paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32},
  headingRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap'},
  heading: {fontFamily: fonts.display, fontSize: 32, color: colors.text},
  subtitle: {fontFamily: fonts.body, fontSize: 17, lineHeight: 25, color: colors.muted},
  action: {minHeight: 48, paddingHorizontal: 8, justifyContent: 'center'},
  actionText: {fontFamily: fonts.medium, fontSize: 16, color: colors.accent},
  grid: {flexDirection: 'row', flexWrap: 'wrap', paddingTop: 22, rowGap: 24},
  cell: {width: '33.333%', alignItems: 'center', paddingHorizontal: 4}, largeCell: {width: '50%'},
  shortcut: {alignItems: 'center', gap: 10, width: '100%', paddingVertical: 4},
  icon: {width: 64, height: 64, borderRadius: 16, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'},
  artwork: {width: '100%', height: '100%', borderRadius: 15},
  spark: {width: 40, height: 40}, monogram: {fontFamily: fonts.strong, fontSize: 25, color: colors.text},
  label: {fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.text, textAlign: 'center'},
  remove: {minHeight: 48, paddingHorizontal: 12, justifyContent: 'center'}, empty: {paddingTop: 32, gap: 16},
});
