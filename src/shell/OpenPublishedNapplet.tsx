import { PublishedLaunchReview } from './PublishedLaunchReview';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SettingsDock } from './SettingsForm';
import { ThumbAction } from './ThumbAction';
import { ShellPressable as Pressable } from './ShellPressable';
import { ShellTextInput as TextInput } from './ShellTextInput';
import type { SettingsActions } from './Shell';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { resolvePublishedReference } from '../napplets/resolve-link';
import { publishedOpenFailureText } from './published-settings-actions';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

/** A trusted settings surface for one explicit published open. */
export function OpenPublishedNapplet({ open, discover, children }: { open: SettingsActions['openPublished']; discover?: SettingsActions['openDiscovery']; children: ReactNode }) {
  const { styles, colors } = useShellStyles(createStyles);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<NappletConsentReview | null>(null);
  const pending = useRef<AbortController | null>(null);
  const decision = useRef<{review: NappletConsentReview; resolve(accepted: boolean): void} | null>(null);
  useEffect(() => () => { pending.current?.abort(); decision.current?.resolve(false); decision.current = null; }, []);
  const settle = (accepted: boolean) => {
    const selected = decision.current;
    decision.current = null;
    selected?.resolve(accepted);
    setReview(null);
  };
  const decide = (accepted: boolean) => {
    if (decision.current?.review === review) settle(accepted);
  };
  const cancel = () => {
    pending.current?.abort(); pending.current = null;
    settle(false); setBusy(false); setError('');
  };
  const start = () => {
    if (busy || pending.current || !link.trim()) return;
    try { resolvePublishedReference(link.trim()); }
    catch { setError('Paste a named napplet address (naddr) or a snapshot event link (nevent).'); return; }
    Keyboard.dismiss();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    void open(link.trim(), controller.signal, request => new Promise<boolean>(resolve => {
      if (controller.signal.aborted) { resolve(false); return; }
      decision.current = {review: request, resolve};
      setReview(request);
    })).catch(error => {
      if (!controller.signal.aborted && pending.current === controller) setError(publishedOpenFailureText(error));
    }).finally(() => {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    });
  };
  if (review) return <PublishedLaunchReview target={{ ...review, requiredDomains: review.domains }}
    title="Allow this napplet?" changesAccess onAccept={() => decide(true)} onCancel={() => decide(false)}
    ids={reviewIds} />;
  const showDiscover = discover && !link.trim();
  return <View style={styles.screen}>
    <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {children}
      <View style={styles.group}>
    <Text accessibilityRole="header" style={styles.title}>Open a napplet</Text>
    <Text style={styles.addressLabel}>Named address or snapshot link</Text>
    <TextInput testID="settings-napplet-address" accessibilityLabel="Napplet address" value={link} onChangeText={value => { setLink(value); setError(''); }}
      autoCapitalize="none" autoCorrect={false} maxLength={8192} editable={!busy} placeholder="naddr1… or nevent1…" placeholderTextColor={colors.muted}
      style={styles.input} returnKeyType="go" onSubmitEditing={start} />
    {error !== '' && <Text testID="settings-napplet-error" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    {busy && <Text testID="settings-napplet-loading" accessibilityLiveRegion="polite" style={styles.detail}>Finding and verifying the signed napplet…</Text>}
      </View>
    </ScrollView>
    <SettingsDock>
    {showDiscover ? <ThumbAction label="Discover napplets" testID="settings-open-discovery" onPress={discover} />
      : <ThumbAction label={busy ? "Verifying…" : "Verify and open"} testID="settings-open-napplet" disabled={busy || !link.trim()} onPress={start} />}
    {busy && <Pressable accessibilityRole="button" testID="settings-napplet-cancel" onPress={cancel} style={styles.secondary}><Text style={styles.secondaryText}>Cancel opening</Text></Pressable>}
    </SettingsDock>
  </View>;
}

const reviewIds = { review: 'settings-napplet-review', approve: 'settings-napplet-approve', cancel: 'settings-napplet-reject' };

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
  addressLabel: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.muted },
  group: { gap: 12 }, title: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 22 },
  error: { fontFamily: fonts.body, color: colors.accent, fontSize: 15, lineHeight: 22 },
  input: { fontFamily: fonts.body, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 0, minHeight: 56, padding: 16, fontSize: 16 },
  secondary: { padding: 18, minHeight: 56, borderRadius: 0, borderColor: colors.border, borderWidth: 1, alignItems: 'center' },
  secondaryText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, color: colors.text, fontSize: 14 },
});
