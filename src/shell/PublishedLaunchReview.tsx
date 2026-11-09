import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Image } from 'expo-image';
import { AccessibilityInfo, AppState, ScrollView, StyleSheet, Text, View, type TextInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { boundedPublishedTitle, snapshotEventId } from '../napplets/published-identity';
import type { VerifiedLaunchMetadata } from '../napplets/verified-launch-metadata';
import { MEDIA_ACCESS_DETAIL } from '../runtime/support-report';
import { formatNpub } from '../security/public-identity';
import { OwnerContext } from './IdentityOwnerContext';
import { ShellModal } from './ShellModal';
import { ShellPressable } from './ShellPressable';
import { TrustedBand } from './TrustedBand';
import { useShellStyles, type ShellFonts, type ShellPalette } from './theme';

type ReviewTarget = Readonly<{
  metadata: VerifiedLaunchMetadata;
  publisher: string;
  eventId: string;
  appId: string;
  requiredDomains: readonly string[];
  optionalDomains: readonly string[];
  unsupportedDomains: readonly string[];
  unsupportedOptionalDomains: readonly string[];
}>;

type LaunchSource = Readonly<{ label: string; publisher?: string }>;

const capabilityCopy = new Map<string, readonly [string, string]>([
  ['shell', ['Shell connection', 'Connect to Hypergolic and check which capabilities are available.']],
  ['identity', ['Public identity', 'Read your public account information. Some public lists need separate approval.']],
  ['storage', ['App storage', 'Save data for this napplet under your selected identity.']],
  ['theme', ['Appearance', 'Follow Hypergolic’s light or dark theme.']],
  ['relay', ['Nostr relays', 'Read events and ask to publish through your configured relays.']],
  ['resource', ['Resources', 'Download bounded public resources through Hypergolic. Files stay in memory while this napplet is open.']],
  ['upload', ['File uploads', 'Ask to upload files you choose to Blossom. Each upload needs your approval.']],
  ['link', ['Web links', 'Ask to open public web links using your device.']],
  ['intent', ['Actions in other napplets', 'Ask an installed napplet to perform an action. Each dispatch needs your approval.']],
  ['inc', ['Messages between napplets', 'Exchange messages with approved peers while Hypergolic is in the foreground.']],
  ['notify', ['Notifications', 'Show notifications inside Hypergolic.']],
  ['config', ['Settings', 'Use and request changes to this napplet’s settings in Hypergolic.']],
  ['outbox', ['Outbox routing', 'Read Nostr events or ask to publish using the relays associated with the accounts involved.']],
  ['keys', ['Keyboard shortcuts', 'Use hardware shortcuts while this napplet has focus.']],
  ['media', ['Media playback', MEDIA_ACCESS_DETAIL]],
  ['cvm', ['External tools', 'Ask to send encrypted requests to free tools. Hypergolic asks you to review the provider and what is sent.']],
  ['common', ['Nostr utilities', 'Use common Nostr tools. Profile lookup, public lists and social actions may need additional access.']],
]);

function CapabilityGroup({ kind, domains, unavailable }: { kind: 'required' | 'optional'; domains: readonly string[]; unavailable: readonly string[] }) {
  const { styles } = useShellStyles(createStyles);
  if (domains.length === 0) return null;
  const missing = new Set(unavailable);
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.sectionTitle}>{kind === 'required' ? 'Required capabilities' : 'Optional capabilities'}</Text>
    {domains.map(domain => {
      const [name, description] = capabilityCopy.get(domain) ?? [domain, 'Declared by the publisher.'];
      return <View key={domain} style={styles.capability}>
        <Text testID={`published-review-${kind}-${domain}`} style={styles.name}>{name}</Text>
        <Text style={styles.detail}>{description}</Text>
        {missing.has(domain) && <Text style={styles.unavailable}>Unavailable in Hypergolic</Text>}
      </View>;
    })}
  </View>;
}

function RequestedAccess({ target, changesAccess }: { target: ReviewTarget; changesAccess: boolean }) {
  const { styles } = useShellStyles(createStyles);
  const { requiredDomains, optionalDomains, unsupportedDomains, unsupportedOptionalDomains } = target;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.label}>Requested access</Text>
    {requiredDomains.length === 0 && optionalDomains.length === 0 && <Text style={styles.body}>No capabilities requested</Text>}
    <CapabilityGroup kind="required" domains={requiredDomains} unavailable={unsupportedDomains} />
    {unsupportedDomains.length > 0 && <Text testID="published-review-unavailable-required" style={styles.detail}>
      This napplet can open with limited features. Features that need unavailable capabilities will be missing.
    </Text>}
    <CapabilityGroup kind="optional" domains={optionalDomains} unavailable={unsupportedOptionalDomains} />
    {unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Features that use unavailable optional capabilities will be missing.</Text>}
    {changesAccess && requiredDomains.length + optionalDomains.length > 0 && <Text style={styles.detail}>
      Hypergolic saves the available access for this publisher and napplet under your selected identity.
    </Text>}
  </View>;
}

function useLaunchArtwork({ publisher, metadata: { icon } }: ReviewTarget) {
  const media = useContext(OwnerContext)?.launchReviewMedia;
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>();
  const [artwork, setArtwork] = useState<string>();
  useEffect(() => {
    if (!media || AppState.currentState !== 'active') return;
    const controller = new AbortController();
    const { signal } = controller;
    const live = () => { if (signal.aborted) throw new Error('Review closed'); };
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') controller.abort(); });
    void media.readProfile(publisher, signal, live).then(result => {
      live();
      setName(boundedPublishedTitle(result?.displayName ?? '') || boundedPublishedTitle(result?.name ?? ''));
      if (result?.picture) return media.readAvatar(result.picture, signal, live);
    }).then(image => {
      if (image) { live(); setAvatar(image.uri); }
    }).catch(() => undefined);
    if (icon) void media.readIcon(icon, signal).then(uri => { live(); setArtwork(uri); }).catch(() => undefined);
    return () => { controller.abort(); subscription.remove(); };
  }, [icon, media, publisher]);
  return { name, avatar, artwork };
}

function ReviewImage({ uri, avatar = false }: { uri: string | undefined; avatar?: boolean }) {
  const { styles } = useShellStyles(createStyles);
  const [failed, setFailed] = useState(false);
  return <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.artwork, avatar && styles.avatar]}>
    {uri && !failed
      ? <Image source={{ uri }} style={styles.image} contentFit="cover" cachePolicy="none" autoplay={false} onError={() => setFailed(true)} />
      : <View style={[styles.mark, avatar && styles.avatarMark]} />}
  </View>;
}

function LaunchIdentity({ target, source }: { target: ReviewTarget; source: LaunchSource | undefined }) {
  const { styles } = useShellStyles(createStyles);
  const { name, avatar, artwork } = useLaunchArtwork(target);
  const { title, description } = target.metadata;
  const [fullDescription, setFullDescription] = useState(false);
  const summary = description.replace(/\s+/gu, ' ');
  const hasLongDescription = summary.length > 180;
  const npub = formatNpub(target.publisher);
  const preview = hasLongDescription ? summary.slice(0, 177).replace(/\s+\S*$/u, '') + '…' : summary;
  return <View style={styles.section}>
    <View style={styles.identityRow}>
      <ReviewImage uri={artwork} />
      <View style={styles.identityCopy}>
        <Text accessibilityRole="header" style={styles.appName}>{title}</Text>
        {source && <Text style={styles.detail}>{source.label}</Text>}
      </View>
    </View>
    <View style={styles.publisherCard}>
      <Text style={styles.label}>Publisher</Text>
      <View style={styles.identityRow}>
        <ReviewImage uri={avatar} avatar />
        <View style={styles.identityCopy}>
          {name !== '' && <Text style={styles.name}>{name}</Text>}
          <Text selectable testID="published-review-publisher" style={styles.mono}>{npub.slice(0, 13)}…{npub.slice(-7)}</Text>
        </View>
      </View>
    </View>
    {description !== '' && <View style={styles.group}>
      <Text style={styles.detail}>{fullDescription ? description : preview}</Text>
      {hasLongDescription && <ShellPressable accessibilityRole="button" accessibilityState={{ expanded: fullDescription }}
        onPress={() => setFullDescription(value => !value)} style={styles.descriptionToggle}>
        <Text style={styles.disclosureText}>{fullDescription ? 'Show less' : 'Read full description'}</Text>
      </ShellPressable>}
    </View>}
  </View>;
}

function TechnicalDetails({ target, source }: { target: ReviewTarget; source: LaunchSource | undefined }) {
  const { styles } = useShellStyles(createStyles);
  const [expanded, setExpanded] = useState(false);
  const { reference, version, htmlHash } = target.metadata;
  const fields = [
    ['Publisher public key', target.publisher],
    ['Signed event', target.eventId],
    ['Publisher npub', formatNpub(target.publisher)],
    ['Publication reference', reference],
    ['Verified artifact version', version],
    ['Verified HTML hash', htmlHash],
  ];
  if (!snapshotEventId(target.appId)) fields.splice(1, 0, ['Publication identifier', target.appId]);
  if (source?.publisher) fields.push(['Requesting catalog key', formatNpub(source.publisher)]);
  return <View style={styles.technical}>
    <ShellPressable accessibilityRole="button" accessibilityLabel="Technical details" accessibilityState={{ expanded }} testID="published-review-technical-toggle"
      onPress={() => setExpanded(value => !value)} style={styles.disclosure}>
      <Text style={styles.disclosureText}>Technical details</Text>
      <Text accessible={false} importantForAccessibility="no" style={styles.disclosureText}>{expanded ? '−' : '+'}</Text>
    </ShellPressable>
    {expanded && <View style={styles.section}>
      {fields.map(([label, value]) => <View key={label} style={styles.group}>
        <Text style={styles.detail}>{label}</Text>
        <Text selectable style={styles.mono}>{value}</Text>
      </View>)}
    </View>}
  </View>;
}

export function PublishedLaunchReview({ target, source, changesAccess, onAccept, onCancel, ids, title = 'Open this napplet?', approveLabel, children }: {
  target: ReviewTarget;
  source?: LaunchSource;
  changesAccess: boolean;
  onAccept(): void;
  onCancel(): void;
  ids: Readonly<{ review: string; approve: string; cancel: string }>;
  title?: string;
  approveLabel?: string;
  children?: ReactNode;
}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  const heading = useRef<TextInstance>(null);
  return <ShellModal visible transparent animationType="none" onRequestClose={onCancel} onShow={() => {
    if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, 'focus');
  }}>
    <View style={[styles.backdrop, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View accessibilityViewIsModal testID={ids.review} style={styles.sheet}>
        <TrustedBand label="Launch review" />
        <ScrollView testID="published-review-content" contentContainerStyle={styles.content} style={styles.scroll}>
          <Text ref={heading} accessibilityRole="header" style={styles.heading}>{title}</Text>
          <LaunchIdentity key={target.eventId} target={target} source={source} />
          <RequestedAccess target={target} changesAccess={changesAccess} />
          {children}
          <TechnicalDetails key={target.eventId} target={target} source={source} />
        </ScrollView>
        <View style={[styles.actions, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <ShellPressable accessibilityRole="button" testID={ids.cancel} onPress={onCancel} style={styles.button}>
            <Text style={styles.buttonText}>Cancel</Text>
          </ShellPressable>
          <ShellPressable accessibilityRole="button" testID={ids.approve} onPress={onAccept} style={[styles.button, styles.primary]}>
            <Text style={[styles.buttonText, styles.primaryText]}>{approveLabel ?? (changesAccess ? 'Allow and open' : 'Open')}</Text>
          </ShellPressable>
        </View>
      </View>
    </View>
  </ShellModal>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', backgroundColor: colors.shade },
  sheet: { maxHeight: '100%', width: '100%', maxWidth: 680, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { padding: 20, gap: 16 },
  heading: { fontFamily: fonts.display, fontSize: 26, color: colors.text },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  identityCopy: { flex: 1, gap: 3 },
  artwork: { width: 52, height: 52, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  mark: { width: 16, height: 16, backgroundColor: colors.accent, transform: [{ rotate: '45deg' }] },
  avatarMark: { width: 12, height: 12, borderRadius: 6 },
  appName: { fontFamily: fonts.strong, fontSize: 23, color: colors.text },
  name: { fontFamily: fonts.strong, fontSize: 16, color: colors.text },
  publisherCard: { gap: 6, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: colors.raised },
  section: { gap: 10 },
  group: { gap: 4 },
  sectionTitle: { fontFamily: fonts.strong, fontSize: 16, color: colors.text },
  label: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: colors.muted },
  body: { fontFamily: fonts.body, fontSize: 16, color: colors.text },
  detail: { fontFamily: fonts.body, fontSize: 14, color: colors.muted },
  mono: { fontFamily: fonts.mono, fontSize: 12, color: colors.text },
  capability: { gap: 3, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.border },
  unavailable: { fontFamily: fonts.strong, fontSize: 14, color: colors.accent },
  descriptionToggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  technical: { gap: 6, borderTopWidth: 1, borderColor: colors.border },
  disclosure: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, gap: 8 },
  disclosureText: { flexShrink: 1, fontFamily: fonts.strong, fontSize: 15, color: colors.accent },
  actions: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: colors.border, gap: 8, paddingHorizontal: 20, paddingTop: 10 },
  button: { flexGrow: 1, flexBasis: '44%', minWidth: 112, minHeight: 48, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  buttonText: { fontFamily: fonts.strong, fontSize: 16, textAlign: 'center', color: colors.text },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryText: { color: colors.onPrimary },
});
