import { PublishedLaunchReview } from './PublishedLaunchReview';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { SettingsComposer, SettingsField, SettingsPrimary, SettingsRoomHeader } from './SettingsRoom';
import { ShellPressable as Pressable } from './ShellPressable';
import type { SettingsActions } from './Shell';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { resolvePublishedReference } from '../napplets/resolve-link';
import { publishedOpenFailureText } from './published-settings-actions';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

/** A trusted settings surface for one explicit published open. */
export function OpenPublishedNapplet({ open, onBack }: { open: SettingsActions['openPublished']; onBack(): void }) {
  const { styles } = useShellStyles(createStyles);
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
  const address = link.trim();
  const valid = isValidAddress(address);
  const message = address && !valid ? 'Enter a valid named napplet address (naddr) or snapshot event link (nevent).' : error;
  const start = () => {
    if (busy || pending.current || !valid) return;
    Keyboard.dismiss();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    void open(address, controller.signal, request => new Promise<boolean>(resolve => {
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
  return <View style={styles.screen}>
    <SettingsRoomHeader title="Open a napplet" onBack={onBack} />
    <View style={styles.space} />
    <SettingsComposer>
      <Text style={styles.detail}>Paste a named napplet address (naddr) or a snapshot link (nevent). This version cannot open root napplets. We’ll verify the signed release and show you its publisher and requested access.</Text>
      <SettingsField testID="settings-napplet-address" accessibilityLabel="Napplet address" value={link}
        onChangeText={value => { setLink(value); setError(''); }} maxLength={8192} editable={!busy}
        placeholder="naddr1… or nevent1…" returnKeyType="go" submitBehavior="submit" onSubmitEditing={start} />
      {message !== '' && <Text testID="settings-napplet-error" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text>}
      {busy && <Text testID="settings-napplet-loading" accessibilityLiveRegion="polite" style={styles.detail}>Finding and verifying the signed napplet…</Text>}
      <SettingsPrimary label={busy ? 'Verifying…' : 'Verify and open'} testID="settings-open-napplet" disabled={busy || !valid} onPress={start} />
      {busy && <Pressable accessibilityRole="button" testID="settings-napplet-cancel" onPress={cancel} style={styles.secondary}><Text style={styles.secondaryText}>Cancel opening</Text></Pressable>}
    </SettingsComposer>
  </View>;
}

function isValidAddress(address: string) {
  if (!address) return false;
  try { resolvePublishedReference(address); return true; }
  catch { return false; }
}

const reviewIds = { review: 'settings-napplet-review', approve: 'settings-napplet-approve', cancel: 'settings-napplet-reject' };

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1 },
  space: { flex: 1 },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 20 },
  error: { fontFamily: fonts.body, color: colors.accent, fontSize: 14, lineHeight: 19 },
  secondary: { alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: fonts.medium, color: colors.accent, fontSize: 15 },
});
