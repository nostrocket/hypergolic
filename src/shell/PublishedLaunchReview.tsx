import {useReviewControl} from './useReviewControl';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { accessIconUri } from './access-icon';
import { Image } from 'expo-image';
import { AccessibilityInfo, AppState, ScrollView, StyleSheet, Text, View, type TextInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { boundedPublishedTitle, publishedAppLabel, snapshotEventId } from '../napplets/published-identity';
import type { VerifiedLaunchMetadata } from '../napplets/verified-launch-metadata';
import { launchAccessCopy } from './launch-access-copy';
import { compactPublisher, formatNpub } from '../security/public-identity';
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

function CapabilityMark({domain, tone}: {domain: string; tone: 'accessSupported' | 'accessRequiredUnavailable' | 'accessOptionalUnavailable'}) {
  const {colors, styles} = useShellStyles(createStyles);
  return <Image source={{uri: accessIconUri(domain, colors[tone])}} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={styles.capabilityMark} contentFit="contain" />;
}

function CapabilityGroup({ kind, domains, unavailable }: { kind: 'required' | 'optional'; domains: readonly string[]; unavailable: readonly string[] }) {
  const { styles } = useShellStyles(createStyles);
  if (domains.length === 0) return null;
  const missing = new Set(unavailable);
  return <View style={styles.group}>
    {kind === 'required' && <Text accessibilityRole="header" style={styles.sectionTitle}>Required access</Text>}
    {domains.map(domain => {
      const unsupported = missing.has(domain);
      const {name, description} = launchAccessCopy(domain, unsupported);
      const tone = unsupported ? (kind === 'required' ? 'accessRequiredUnavailable' : 'accessOptionalUnavailable') : 'accessSupported';
      return <View key={domain} style={styles.capability}>
        <CapabilityMark domain={domain} tone={tone} />
        <View style={styles.capabilityCopy}><Text testID={`published-review-${kind}-${domain}`} style={styles.name}>{name}</Text>
        <Text style={styles.detail}>{description}</Text></View>
      </View>;
    })}
  </View>;
}

function RequestedAccess({ target, changesAccess }: { target: ReviewTarget; changesAccess: boolean }) {
  const { styles } = useShellStyles(createStyles);
  const { requiredDomains, optionalDomains, unsupportedDomains, unsupportedOptionalDomains } = target;
  const [optionalExpanded, setOptionalExpanded] = useState(false);
  return <View style={styles.section}>
    {requiredDomains.length === 0 && optionalDomains.length === 0 && <Text style={styles.body}>No capabilities requested</Text>}
    <CapabilityGroup kind="required" domains={requiredDomains} unavailable={unsupportedDomains} />
    {unsupportedDomains.length > 0 && <Text testID="published-review-unavailable-required" style={styles.detail}>
      This napplet can open with limited features. Features that need unavailable capabilities will be missing.
    </Text>}
    {optionalDomains.length > 0 && <View style={styles.technical}>
      <ShellPressable accessibilityRole="button" accessibilityLabel="Optional access" accessibilityState={{expanded: optionalExpanded}}
        testID="published-review-optional-toggle" onPress={() => setOptionalExpanded(value => !value)} style={styles.disclosure}>
        <Text style={styles.sectionTitle}>Optional access · {optionalDomains.length}</Text>
        <Text accessible={false} style={styles.disclosureText}>{optionalExpanded ? '−' : '+'}</Text>
      </ShellPressable>
      <Text style={styles.detail}>Opening also grants available optional access.</Text>
      {unsupportedOptionalDomains.length > 0 && <Text style={styles.detail}>Unavailable optional access: {unsupportedOptionalDomains.map(domain => launchAccessCopy(domain, true).name).join(', ')}.</Text>}
      {optionalExpanded && <CapabilityGroup kind="optional" domains={optionalDomains} unavailable={unsupportedOptionalDomains} />}
    </View>}
    {changesAccess && requiredDomains.length + optionalDomains.length > 0 && <Text style={styles.detail}>
      Hypergolic saves the available access for this publisher and napplet under your selected identity.
    </Text>}
  </View>;
}

function useLaunchArtwork({ publisher, metadata: { icon } }: ReviewTarget) {
  const media = useContext(OwnerContext)?.launchReviewMedia;
  const [name, setName] = useState('');
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
    }).catch(() => undefined);
    if (icon) void media.readIcon(icon, signal).then(uri => { live(); setArtwork(uri); }).catch(() => undefined);
    return () => { controller.abort(); subscription.remove(); };
  }, [icon, media, publisher]);
  return { name, artwork };
}

function ReviewImage({ uri }: { uri: string | undefined }) {
  const { styles } = useShellStyles(createStyles);
  const [failedUri, setFailedUri] = useState<string>();
  return <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.artwork}>
    {uri && failedUri !== uri
      ? <Image source={{ uri }} style={styles.image} contentFit="cover" cachePolicy="none" autoplay={false} onError={() => setFailedUri(uri)} />
      : <View style={styles.mark} />}
  </View>;
}

function LaunchIdentity({ target, source }: { target: ReviewTarget; source: LaunchSource | undefined }) {
  const { styles } = useShellStyles(createStyles);
  const { name, artwork } = useLaunchArtwork(target);
  return <View style={styles.section}>
    <View style={styles.identityRow}>
      <ReviewImage uri={artwork} />
      <View style={styles.identityCopy}>
        <Text testID="published-review-publisher" style={styles.name}>Publisher · {compactPublisher(target.publisher)}</Text>
        {name && <Text style={styles.detail}>Profile name · {name}</Text>}
        {source && <Text style={styles.detail}>{source.label}</Text>}
      </View>
    </View>
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
  if (!snapshotEventId(target.appId)) fields.splice(1, 0, ['Publication identifier', publishedAppLabel(target.appId)]);
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

export function PublishedLaunchReview({ target, source, changesAccess, onAccept, onCancel, ids, title, approveLabel, readOnly = false, children }: {
  target: ReviewTarget;
  source?: LaunchSource;
  changesAccess: boolean;
  onAccept(): void;
  onCancel(): void;
  ids: Readonly<{ review: string; approve: string; cancel: string }>;
  title?: string;
  approveLabel?: string;
  readOnly?: boolean;
  children?: ReactNode;
}) {
  const { styles } = useShellStyles(createStyles);
  const insets = useSafeAreaInsets();
  const heading = useRef<TextInstance>(null);
  const control = useReviewControl(target.eventId);
  return <ShellModal key={target.eventId} visible transparent animationType="none" onRequestClose={onCancel} onShow={() => {
    control.onShow();
    if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, 'focus');
  }}>
    <View style={[styles.backdrop, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View accessibilityViewIsModal testID={ids.review} style={styles.sheet}>
        <TrustedBand label="Launch review" />
        <ScrollView testID="published-review-content" contentContainerStyle={styles.content} style={styles.scroll}>
          <Text ref={heading} accessibilityRole="header" style={styles.heading}>{title ?? `Open ${target.metadata.title}?`}</Text>
          <LaunchIdentity key={`${target.publisher}:${target.eventId}:${target.metadata.icon ?? ''}`} target={target} source={source} />
          {readOnly ? <Text style={styles.body}>Legacy read-only mode supplies compatibility libraries and bounded public content. Declared capability access is not granted. Signing, publishing and uploads are unavailable.</Text> : <RequestedAccess key={`access:${target.eventId}`} target={target} changesAccess={changesAccess} />}
          <Text style={styles.detail}>Hypergolic restricts direct network connections. Full network isolation is still being tested on mobile devices.</Text>
          {children}
          <TechnicalDetails key={`technical:${target.eventId}`} target={target} source={source} />
        </ScrollView>
        <View style={[styles.actions, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <ShellPressable accessibilityRole="button" testID={ids.cancel} onPress={onCancel} style={styles.button}>
            <Text style={styles.buttonText}>Cancel</Text>
          </ShellPressable>
          <ShellPressable accessibilityRole="button" testID={ids.approve} disabled={!control.ready} onPress={onAccept} style={[styles.button, styles.primary]}>
            <Text style={[styles.buttonText, styles.primaryText]}>{approveLabel ?? (changesAccess ? 'Allow and open' : 'Open')}</Text>
          </ShellPressable>
        </View>
      </View>
    </View>
  </ShellModal>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', backgroundColor: colors.shade },
  sheet: { flex: 1, maxHeight: '100%', width: '100%', maxWidth: 680, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  scroll: { flex: 1 },
  content: { padding: 22, gap: 24 },
  heading: { fontFamily: fonts.display, fontSize: 30, color: colors.text },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  identityCopy: { flex: 1, gap: 3 },
  artwork: { width: 68, height: 68, borderRadius: 10, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  mark: { width: 16, height: 16, backgroundColor: colors.accent, transform: [{ rotate: '45deg' }] },
  name: { fontFamily: fonts.strong, fontSize: 18, color: colors.text },
  section: { gap: 10 },
  group: { gap: 4 },
  sectionTitle: { fontFamily: fonts.strong, fontSize: 21, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 16, color: colors.text },
  detail: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23, color: colors.muted },
  mono: { fontFamily: fonts.mono, fontSize: 12, color: colors.text },
  capability: { flexDirection: 'row', alignItems: 'flex-start', gap: 18, paddingVertical: 18, borderBottomWidth: 1, borderColor: colors.border },
  capabilityCopy: {flex: 1, gap: 7},
  capabilityMark: {width: 32, height: 32, marginTop: 2},
  technical: { gap: 6, borderTopWidth: 1, borderColor: colors.border },
  disclosure: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, gap: 8 },
  disclosureText: { flexShrink: 1, fontFamily: fonts.strong, fontSize: 15, color: colors.accent },
  actions: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: colors.border, gap: 8, paddingHorizontal: 20, paddingTop: 10 },
  button: { flexGrow: 1, flexBasis: '44%', minWidth: 112, minHeight: 48, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  buttonText: { fontFamily: fonts.strong, fontSize: 16, textAlign: 'center', color: colors.text },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryText: { color: colors.onPrimary },
});
