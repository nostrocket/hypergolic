import { useRef } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, type TextInstance } from 'react-native';
import { ShellModal as Modal } from './ShellModal';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { ShellPressable as Pressable } from './ShellPressable';
import { TrustedBand } from './TrustedBand';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

export function DiscoveryAccessReview({ review, decide }: {
  review: NappletConsentReview | null; decide(accepted: boolean): void;
}) {
  const { styles } = useShellStyles(createStyles);
  const heading = useRef<TextInstance>(null);
  return <Modal visible={review !== null} animationType="none" onRequestClose={() => decide(false)} onShow={() => {
    heading.current?.focus();
    if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, 'focus');
  }}><SafeAreaProvider><SafeAreaView style={styles.screen}>
    {review && <><TrustedBand label="Catalog access" /><ScrollView contentContainerStyle={styles.content}>
      <Text ref={heading} accessibilityRole="header" style={styles.heading}>Allow catalog access?</Text>
      <Text style={styles.body}>This verified catalog release needs your review before it can replace the current one.</Text>
      <Text style={styles.body}>Publisher</Text><Text selectable style={styles.claim}>{review.publisher}</Text>
      <Text style={styles.body}>Catalog</Text><Text selectable style={styles.claim}>{review.appId}</Text>
      <Text style={styles.body}>Release</Text><Text selectable style={styles.claim}>{review.eventId}</Text>
      <Text style={styles.body}>Required access · {review.domains.join(', ') || 'none'}</Text>
      <Text style={styles.body}>Optional access · {review.optionalDomains.join(', ') || 'none'}</Text>
      {review.unsupportedDomains.length > 0 && <Text style={styles.body}>Required capabilities unavailable · {review.unsupportedDomains.join(', ')}</Text>}
      {review.unsupportedOptionalDomains.length > 0 && <Text style={styles.body}>Optional capabilities unavailable · {review.unsupportedOptionalDomains.join(', ')}</Text>}
      <Pressable accessibilityRole="button" testID="discovery-access-accept" onPress={() => decide(true)} style={styles.primary}><Text style={styles.primaryText}>Allow and update</Text></Pressable>
      <Pressable accessibilityRole="button" testID="discovery-access-cancel" onPress={() => decide(false)} style={styles.secondary}><Text style={styles.body}>Keep current catalog</Text></Pressable>
    </ScrollView></>}
  </SafeAreaView></SafeAreaProvider></Modal>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: 24, gap: 16, flexGrow: 1},
  heading: {fontFamily: fonts.display, fontSize: 28, color: colors.text},
  body: {fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: colors.text},
  claim: {fontFamily: fonts.mono, fontSize: 12, color: colors.text},
  primary: {minHeight: 52, padding: 16, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.primary},
  primaryText: {fontFamily: fonts.strong, fontSize: 16, color: colors.onPrimary},
  secondary: {minHeight: 52, padding: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.border},
});
