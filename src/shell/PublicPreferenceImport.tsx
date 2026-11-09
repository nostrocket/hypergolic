import {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {AccessibilityInfo, AppState, ScrollView, StyleSheet, Text, View, type TextInstance} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import type {CatalogHandler, CatalogSnapshot} from '../routing/routing-catalog';
import {PublicPreferenceError} from '../routing/public-preference-plan';
import type {PublicPreferenceImportService, PublicPreferenceReview, PublicPreferenceRow} from '../routing/public-preference-import';
import {formatNpub} from '../security/public-identity';
import {ShellModal} from './ShellModal';
import {ShellPressable} from './ShellPressable';
import {TrustedBand} from './TrustedBand';
import {useShellStyles, type ShellPalette, type ShellFonts} from './theme';

type ImportFlight = {
  service: PublicPreferenceImportService;
  controller: AbortController;
  review?: PublicPreferenceReview;
  accepting: boolean;
};
type ImportView = {service: PublicPreferenceImportService} & (
  {phase: 'loading'} | {phase: 'error'; message: string} | {phase: 'review' | 'saving'; review: PublicPreferenceReview}
);

function stop(flight: ImportFlight) {
  flight.controller.abort();
  if (flight.review) flight.service.cancel(flight.review);
}

function ImportButton({id, title, disabled = false, onPress}: {id: string; title: string; disabled?: boolean; onPress(): void}) {
  const {styles} = useShellStyles(createStyles);
  return <ShellPressable testID={id} accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled}
    onPress={onPress} style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.buttonLabel}>{title}</Text>
  </ShellPressable>;
}

function HandlerIdentity({label, handler}: {label: string; handler: CatalogHandler | null}) {
  const {styles} = useShellStyles(createStyles);
  return <View style={styles.group}>
    <Text style={styles.label}>{label}</Text>
    {handler ? <>
      <Text style={styles.body}>{handler.title}</Text>
      <Text style={styles.label}>Publisher</Text>
      <Text selectable style={styles.claim}>{formatNpub(handler.publisher)}</Text>
      <Text style={styles.label}>Manifest event ID</Text>
      <Text selectable style={styles.claim}>{handler.eventId}</Text>
    </> : <Text style={styles.body}>None</Text>}
  </View>;
}

function PreferenceRow({row, saving, choose}: {row: PublicPreferenceRow; saving: boolean; choose(row: PublicPreferenceRow): void}) {
  const {styles} = useShellStyles(createStyles);
  const [first, ...later] = row.references;
  return <View style={styles.row} testID={'public-preference-row-' + row.id}>
    <Text accessibilityRole="header" style={styles.title}>{row.archetype}</Text>
    <Text style={styles.label}>Published preference event ID</Text>
    <Text selectable style={styles.claim}>{row.eventId}</Text>
    <HandlerIdentity label="Current default" handler={row.current} />
    <HandlerIdentity label="Proposed default" handler={row.target} />
    {first && <View style={styles.group}>
      <Text style={styles.label}>First published reference</Text>
      <Text selectable style={styles.claim}>{first}</Text>
    </View>}
    {later.length > 0 && <View style={styles.group}>
      <Text style={styles.label}>Later references (not applied)</Text>
      <Text selectable style={styles.claim}>{later.join("\n")}</Text>
    </View>}
    {row.ignoredActions.length > 0 && <View style={styles.group}>
      <Text style={styles.label}>Published actions (not applied)</Text>
      <Text selectable style={styles.claim}>{row.ignoredActions.join("\n")}</Text>
    </View>}
    {row.unavailableReason && <Text style={styles.detail}>{row.unavailableReason}</Text>}
    {row.target && row.unavailableReason === null && <ImportButton id={'public-preference-accept-' + row.id}
      title={`Use ${row.target.title} for ${row.archetype}`} disabled={saving} onPress={() => choose(row)} />}
  </View>;
}

export function PublicPreferenceImport({service, disabled, reserve, finish}: {
  service: PublicPreferenceImportService;
  disabled: boolean;
  reserve(): boolean;
  finish(snapshot?: CatalogSnapshot | null): void;
}) {
  const {styles} = useShellStyles(createStyles);
  const [view, setView] = useState<ImportView | null>(null);
  const flight = useRef<ImportFlight | null>(null);
  const heading = useRef<TextInstance>(null);
  const visible = view?.service === service ? view : null;

  const cancel = useCallback(() => {
    const active = flight.current;
    if (!active) return;
    flight.current = null;
    stop(active);
    setView(null);
    finish();
  }, [finish]);

  useLayoutEffect(() => {
    const subscription = AppState.addEventListener('change', next => {if (next !== 'active') cancel();});
    return () => {
      subscription.remove();
      cancel();
    };
  }, [service, cancel]);

  async function open() {
    if (disabled || flight.current || AppState.currentState !== 'active' || !reserve()) return;
    const active: ImportFlight = {service, controller: new AbortController(), accepting: false};
    flight.current = active;
    setView({service, phase: 'loading'});
    try {
      const review = await service.preview({signal: active.controller.signal});
      if (flight.current !== active) {
        service.cancel(review);
        return;
      }
      active.review = review;
      setView({service, phase: 'review', review});
    } catch (error) {
      if (flight.current === active) setView({service, phase: 'error',
        message: error instanceof PublicPreferenceError ? error.message : 'Published app choices are unavailable.'});
    }
  }

  async function choose(review: PublicPreferenceReview, row: PublicPreferenceRow) {
    const active = flight.current;
    if (active?.review !== review || active.accepting || active.service !== service || !row.target ||
        row.unavailableReason !== null || AppState.currentState !== 'active') return;
    active.accepting = true;
    setView({service, phase: 'saving', review});
    try {
      const result = await service.accept(review, row.id, {signal: active.controller.signal});
      if (flight.current !== active) return;
      flight.current = null;
      setView(null);
      finish(result.status === 'saved' ? result.snapshot : null);
    } catch {
      if (flight.current === active) setView({service, phase: 'error', message: 'Could not confirm the default. Close this review and reopen Settings to check saved handlers.'});
    }
  }

  const review = visible?.phase === 'review' || visible?.phase === 'saving' ? visible.review : null;
  return <>
    <ImportButton id="public-preference-review" title="Review published app choices" disabled={disabled || visible !== null}
      onPress={() => {void open();}} />
    {visible && <ShellModal visible animationType="none" onRequestClose={cancel} onShow={() => {
      heading.current?.focus();
      if (heading.current) AccessibilityInfo.sendAccessibilityEvent(heading.current, 'focus');
    }}>
      <SafeAreaProvider>
        <SafeAreaView accessibilityViewIsModal style={styles.screen} testID="public-preference-modal">
          <TrustedBand label="Published app choices" />
          <ScrollView contentContainerStyle={styles.content}>
            <Text ref={heading} accessibilityRole="header" style={styles.heading}>Review published app choices</Text>
            {visible.phase === 'loading' && <Text accessibilityLiveRegion="polite" style={styles.body}>Loading your published choices…</Text>}
            {visible.phase === 'error' && <Text accessibilityLiveRegion="polite" style={styles.body}>{visible.message}</Text>}
            {review && <>
              <Text style={styles.label}>Selected account</Text>
              <Text selectable style={styles.claim}>{formatNpub(review.account)}</Text>
              <Text style={styles.body}>Choose one installed handler to set as your default. Dispatch still needs your approval.</Text>
              {review.limited && <Text style={styles.detail}>The relay lookup reached its limit. Some choices may be missing.</Text>}
              {review.rows.length === 0 && <Text style={styles.detail}>No published app choices found.</Text>}
              {visible.phase === 'saving' && <Text accessibilityLiveRegion="polite" style={styles.body}>Saving default…</Text>}
              {review.rows.map(row => <PreferenceRow key={row.id} row={row} saving={visible.phase === 'saving'} choose={row => {void choose(review, row);}} />)}
            </>}
          </ScrollView>
          <View style={styles.footer}><ImportButton id="public-preference-cancel" title="Cancel" onPress={cancel} /></View>
        </SafeAreaView>
      </SafeAreaProvider>
    </ShellModal>}
  </>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: 24, gap: 16},
  footer: {paddingHorizontal: 24, paddingVertical: 12, borderTopWidth: 1, borderColor: colors.border},
  heading: {fontFamily: fonts.display, fontSize: 28, color: colors.text},
  title: {fontFamily: fonts.strong, fontSize: 18, color: colors.text},
  body: {fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: colors.text},
  detail: {fontFamily: fonts.body, fontSize: 14, lineHeight: 21, color: colors.muted},
  label: {fontFamily: fonts.strong, fontSize: 14, color: colors.muted},
  claim: {fontFamily: fonts.mono, fontSize: 12, lineHeight: 19, color: colors.text},
  row: {borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12},
  group: {gap: 4},
  button: {minHeight: 52, padding: 14, justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border},
  buttonLabel: {fontFamily: fonts.strong, color: colors.text, fontSize: 15},
  disabled: {opacity: 0.5},
});
