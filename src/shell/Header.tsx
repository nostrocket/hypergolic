import { StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { Image, type ImageProps } from 'expo-image';
import { useState, type Ref } from 'react';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

/** Supplied by the trusted identity service. This component never resolves profile URLs. */
export interface ShellIdentity { npub: string; avatar?: ImageProps['source']; avatarKey?: string }
interface Props {
  title: string; identity?: ShellIdentity; compact?: boolean; disabled?: boolean;
  onSettings(): void; onOverview?(): void; onMenu?(): void; menuAnchor?: Ref<View>;
}

function Avatar({ identity }: { identity: ShellIdentity }) {
  const { styles } = useShellStyles(createStyles);
  const [failedSource, setFailedSource] = useState<ImageProps['source'] | null>(null);
  return identity.avatar && identity.avatar !== failedSource
    ? <Image source={identity.avatar} style={styles.avatar} cachePolicy="none" autoplay={false} onError={() => setFailedSource(identity.avatar ?? null)} accessible={false} />
    : <View style={styles.avatar} accessible={false}><Text style={styles.avatarText}>{identity.npub.slice(-2).toUpperCase()}</Text></View>;
}

export function Header({ title, identity, compact = false, disabled = false, onSettings, onOverview, onMenu, menuAnchor }: Props) {
  const { styles } = useShellStyles(createStyles);
  return (
    <View testID="shell-header" style={[styles.header, compact && styles.compact]}>
      {onOverview ? <Pressable testID="shell-overview" accessibilityRole="button" accessibilityLabel="All napplets" disabled={disabled} onPress={onOverview} style={styles.iconButton}>
        <Image source={require('../../assets/brand/hypergolic-logo.png')} style={styles.compactLogo} contentFit="contain" accessible={false} />
      </Pressable> : <Image source={require('../../assets/brand/hypergolic-logo.png')} style={styles.logo} contentFit="contain" accessibilityLabel="Hypergolic" />}
      {onMenu ? <View style={styles.focusedTitle}>
        <Text accessibilityRole="header" accessibilityLabel={title} numberOfLines={1} style={styles.compactTitle} testID="focused-napplet-name">{title}</Text>
        <Pressable ref={menuAnchor} accessibilityRole="button" accessibilityLabel={`Options for ${title}`} disabled={disabled} onPress={onMenu} testID="shell-napplet-menu" style={styles.menuTarget} />
      </View> : <Text accessibilityRole="header" accessibilityLabel={title} numberOfLines={1} style={styles.title} testID="focused-napplet-name">{title}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={identity ? `Settings for ${identity.npub}` : 'Settings'} disabled={disabled} onPress={onSettings} testID="shell-settings" style={({ pressed }) => [compact ? styles.iconButton : styles.settings, pressed && styles.pressed]}>
        {identity ? <Avatar key={`${identity.npub}:${identity.avatarKey ?? ''}`} identity={identity} /> : <View style={styles.settingsMark} accessible={false}><View style={styles.settingsDot} /></View>}
        {!compact && <Text numberOfLines={1} style={[styles.identity, identity && styles.npub]}>{identity ? `${identity.npub.slice(0, 8)}…${identity.npub.slice(-4)}` : 'Settings'}</Text>}
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  header: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  compact: { minHeight: 44, paddingHorizontal: 6, paddingVertical: 0, gap: 0, borderBottomWidth: 1, borderBottomColor: colors.subtle, backgroundColor: colors.background },
  compactLogo: { width: 24, height: 24 },
  iconButton: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  focusedTitle: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  compactTitle: { fontFamily: fonts.medium, flexShrink: 1, marginHorizontal: 8, fontSize: 15, color: colors.text },
  menuTarget: StyleSheet.absoluteFill,
  logo: { width: 32, height: 32 },
  title: { fontFamily: fonts.medium, flex: 1, fontSize: 16, color: colors.text, letterSpacing: 1.6, textTransform: 'uppercase' },
  settings: { minHeight: 48, maxWidth: '48%', paddingLeft: 8, paddingRight: 0, flexDirection: 'row', gap: 8, alignItems: 'center' },
  pressed: { backgroundColor: colors.raised },
  identity: { fontFamily: fonts.body, color: colors.text, fontSize: 12, flexShrink: 1 },
  npub: { fontFamily: fonts.mono, color: colors.muted },
  avatar: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.strong, fontSize: 11, color: colors.text },
  settingsMark: { width: 30, height: 30, borderWidth: 1.5, borderColor: colors.muted, borderRadius: 0, alignItems: 'center', justifyContent: 'center' },
  settingsDot: { width: 8, height: 8, borderWidth: 1.5, borderColor: colors.muted, borderRadius: 0 },
});
