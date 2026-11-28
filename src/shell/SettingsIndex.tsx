import { StyleSheet, Text, View } from 'react-native';
import { buildInfo, developerToolsEnabled } from '../config/build-info';
import { connectionLinks, roomTitles, settingsLinks, type RoomLink, type SettingsRoom } from './settings-directory';
import { LaunchHorizon } from './ShellBackdrop';
import { ShellPressable } from './ShellPressable';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

type OpenRoom = (room: SettingsRoom) => void;

function RoomLinks({links, open}: {links: readonly RoomLink[]; open: OpenRoom}) {
  const {styles} = useShellStyles(createStyles);
  return <View>{links.map(({room, detail, accent}, index) =>
    <ShellPressable key={room} accessibilityRole="button" testID={`settings-section-${room}`}
      onPress={() => open(room)} style={[styles.row, index < links.length - 1 && styles.divider]}>
      <View style={styles.label}>
        <Text style={styles.title}>{roomTitles[room]}</Text>
        {detail && <Text style={[styles.detail, accent && styles.accent]}>{detail}</Text>}
      </View>
      <Text accessible={false} importantForAccessibility="no" style={styles.chevron}>›</Text>
    </ShellPressable>)}</View>;
}

export function SettingsIndex({npub, identities, lock, published, open}: {
  npub: string; identities: number; lock: boolean | undefined; published: boolean; open: OpenRoom;
}) {
  const {styles} = useShellStyles(createStyles);
  const links = settingsLinks({identities, lock, published, developer: developerToolsEnabled, version: buildInfo.version});
  return <>
    <View style={styles.card}>
      <LaunchHorizon />
      <View style={styles.identity}>
        <Text style={styles.eyebrow}>Active identity</Text>
        <Text selectable testID="settings-full-npub" style={styles.npub}>{npub}</Text>
      </View>
    </View>
    <RoomLinks links={links} open={open} />
  </>;
}

export function ConnectionsIndex({open}: {open: OpenRoom}) {
  return <RoomLinks links={connectionLinks} open={open} />;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  card: {borderRadius: 6, overflow: 'hidden', backgroundColor: colors.surface},
  identity: {paddingHorizontal: 12, paddingVertical: 10, gap: 4},
  eyebrow: {fontFamily: fonts.medium, fontSize: 11, letterSpacing: 0.7, color: colors.muted, textTransform: 'uppercase'},
  npub: {fontFamily: fonts.mono, fontSize: 13, lineHeight: 19, color: colors.text},
  row: {minHeight: 56, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', gap: 12},
  divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.subtle},
  label: {flex: 1, gap: 2},
  title: {fontFamily: fonts.medium, color: colors.text, fontSize: 18, lineHeight: 22},
  detail: {fontFamily: fonts.body, color: colors.muted, fontSize: 14, lineHeight: 18},
  accent: {fontFamily: fonts.medium, color: colors.accent},
  chevron: {fontFamily: fonts.body, fontSize: 24, lineHeight: 28, color: colors.muted},
});
