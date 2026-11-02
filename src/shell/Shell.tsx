import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceMenu } from './WorkspaceMenu';
import { useWorkspaceMenu } from './useWorkspaceMenu';
import { useWorkspaceBack } from './useWorkspaceBack';
import { useBundledNapplets } from './useBundledNapplets';
import { publishedSettingsActions } from './published-settings-actions';
import { ShellBackdrop } from './ShellBackdrop';
import {useCloseChecks} from './useCloseChecks';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AccessibilityInfo, Keyboard, Modal, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import { cancelAnimation, Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { HostEvent } from '../runtime/NappletHost';
import { ClosePrompt } from './ClosePrompt';
import { type ShellIdentity } from './Header';
import type { OverviewHandle } from './Overview';
import { WorkspaceStage } from './WorkspaceStage';
import { directionForHandle, type HandleSide } from './motion';
import { adjacentNapplet, closeNapplet, focusNapplet, showOverview, type NappletDescriptor, type Workspace } from './workspace';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';
import { RuntimeContext } from '../runtime/RuntimeContext';
import { ReviewFocus } from './ReviewFocus';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import type { PublishedUpdateReview } from '../napplets/published-session';

import { initialTestWorkspace, type BundledVariant } from './fixtures';

const noPending = new Set<string>();
export interface SettingsActions {
  closeSettings: () => void;
  openBundledTest: () => void;
  openStateLab: (variant: Exclude<BundledVariant, 'ux-lab'>) => void;
  openPublished: (link: string, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) => Promise<void>;
  publishedSessions: readonly NappletDescriptor[];
  checkPublishedUpdate: (session: NappletDescriptor, signal: AbortSignal,
    reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>,
    reviewConsent: (request: NappletConsentReview) => Promise<boolean>) => Promise<boolean>;
}
export interface ShellProps {
  blocked?: boolean;
  initialWorkspace?: Workspace;
  workspace?: Workspace;
  onWorkspaceChange?: (workspace: Workspace) => void;
  identity?: ShellIdentity;
  pendingApprovals?: ReadonlySet<string>;
  canCloseWithoutWarning?: (sessionId: string) => boolean;
  footer?: ReactNode;
  onBeforeClose?: (session: NappletDescriptor) => void;
  onHostEvent?: (event: HostEvent) => void;
  settingsComponent?: ComponentType<SettingsActions>;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

export function Shell({ blocked = false, initialWorkspace, workspace: controlledWorkspace, onWorkspaceChange, identity, pendingApprovals, canCloseWithoutWarning, onBeforeClose, onHostEvent, footer, settingsComponent: SettingsContent }: ShellProps) {
  const { styles } = useShellStyles(createStyles);
  const runtime = useContext(RuntimeContext);
  const [localWorkspace, setLocalWorkspace] = useState(() => initialWorkspace ?? initialTestWorkspace());
  const workspace = controlledWorkspace ?? localWorkspace;
  const current = useRef(workspace);
  useLayoutEffect(() => { current.current = workspace; }, [workspace]);
  const change = useCallback((next: Workspace) => {
    current.current = next;
    if (controlledWorkspace === undefined) setLocalWorkspace(next);
    onWorkspaceChange?.(next);
  }, [onWorkspaceChange, controlledWorkspace]);
  const [settings, setSettings] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [handleDragging, setHandleDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastCloseId = useRef<string | null>(null);
  const overview = useRef<OverviewHandle>(null);
  const {closeChecks, closeCheck, receiveHostEvent, requestClose: checkClose} = useCloseChecks({
    workspace: current, blocked, identity: identity?.npub, lifetime: runtime,
    pendingApprovals, canCloseWithoutWarning, onClean: closeSession, onWarning: setClosingId, onHostEvent,
  });
  const focusedIndex = Math.max(0, workspace.sessions.findIndex(session => session.id === workspace.focusedId));
  const focused = workspace.sessions.find(session => session.id === workspace.focusedId);
  const { session: menuSession, visible: menuVisible, anchor: menuAnchor, dismiss: dismissMenu, open: openMenu, clear: clearMenu } =
    useWorkspaceMenu(focused, workspace.overview, { blocked, busy: busyRef, dragging: handleDragging, closeChecks });
  const obscured = settings || menuVisible || closingId !== null;
  const navigationBlocked = blocked || busy || closeCheck !== null;
  const progress = useSharedValue(workspace.overview ? 1 : 0);
  const position = useSharedValue(focusedIndex);
  const scrollY = useSharedValue(0);
  const swipeY = useSharedValue(0);
  const swipeId = useSharedValue<string | null>(null);
  const animation = useRef<{ value: SharedValue<number>; token: symbol } | null>(null);
  const reduced = useReducedMotion();
  const keyboardVisible = useRef(false);
  const runAnimation = useCallback((value: SharedValue<number>, toValue: number, done: () => void, duration = 280) => {
    if (animation.current) cancelAnimation(animation.current.value);
    const token = Symbol('transition');
    animation.current = { value, token };
    busyRef.current = true;
    setBusy(true);
    const finish = (finished: boolean) => {
      if (animation.current?.token !== token) return;
      animation.current = null;
      busyRef.current = false;
      setBusy(false);
      if (finished) done();
    };
    value.set(withTiming(toValue, { duration: reduced ? 0 : duration, easing: Easing.out(Easing.cubic) }, finished => {
      scheduleOnRN(finish, finished === true);
    }));
  }, [reduced]);
  useEffect(() => () => {
    const running = animation.current;
    animation.current = null;
    if (running) cancelAnimation(running.value);
  }, []);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => { keyboardVisible.current = true; });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { keyboardVisible.current = false; });
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  useEffect(() => {
    if (!busyRef.current) { position.set(focusedIndex); progress.set(workspace.overview ? 1 : 0); }
  }, [focusedIndex, position, progress, workspace.overview]);

  const focusSession = useCallback((id: string) => {
    if (blocked || busyRef.current || closeChecks.isPending()) return;
    const state = current.current;
    const index = state.sessions.findIndex(session => session.id === id);
    if (index < 0) return;
    Keyboard.dismiss();
    position.set(index);
    change(focusNapplet(state, id));
    runAnimation(progress, 0, () => AccessibilityInfo.announceForAccessibility(state.sessions[index].title));
  }, [blocked, change, closeChecks, position, progress, runAnimation]);
  const openOverview = useCallback(() => {
    if (blocked || busyRef.current || closeChecks.isPending()) return;
    Keyboard.dismiss();
    overview.current?.revealCard(current.current.focusedId);
    change(showOverview(current.current));
    runAnimation(progress, 1, () => overview.current?.focusCard(current.current.focusedId));
  }, [blocked, change, closeChecks, progress, runAnimation]);
  useWorkspaceBack({ workspace, blocked, menuVisible, busy: busyRef, keyboard: keyboardVisible,
    closeChecks, dismissMenu, openOverview, focusSession });
  const onHandleEnd = (side: HandleSide, result: 'overview' | 'switch' | 'cancel') => handleWorkspaceGestureEnd({
    side, result, blocked, busyRef, focusedIndex, current, position, openOverview, runAnimation, change,
    setHandleDragging,
  });
  function closeSession(id: string) {
    closeChecks.forget(id);
    confirmWorkspaceNappletClose({closingId: id, current, onBeforeClose, runtime, change, setClosingId, lastCloseId, overview});
  }
  const requestClose = (id: string) => {
    if (blocked || busyRef.current || closeChecks.isPending()) return;
    Keyboard.dismiss();
    lastCloseId.current = id;
    void checkClose(id);
  };
  const keepOpen = () => {
    setClosingId(null);
    // Modal's Android onDismiss is not guaranteed; focus follows the next commit too.
    requestAnimationFrame(() => overview.current?.focusCard(lastCloseId.current));
  };
  const confirmClose = () => { if (closingId) closeSession(closingId); };
  const openSettings = () => { if (!blocked && !busyRef.current && !closeChecks.isPending()) { Keyboard.dismiss(); setSettings(true); } };
  const openFixture = useBundledNapplets({ current, runtime, position, progress, change, setSettings });
  const openBundledTest = () => openFixture('ux-lab');
  const publishedActions = () => publishedSettingsActions({
    runtime, blocked, getWorkspace: () => current.current, position, progress, change, setSettings, onBeforeClose,
  });
  const openPublished: SettingsActions['openPublished'] = (...args) => publishedActions().openPublished(...args);
  const checkPublishedUpdate: SettingsActions['checkPublishedUpdate'] = (...args) => publishedActions().checkPublishedUpdate(...args);
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'right', 'bottom', 'left']}>
      <ShellBackdrop mood={workspace.overview ? 'shelf' : 'running'} />
      <ReviewFocus sessionId={workspace.focusedId} overview={workspace.overview} busy={busy} dragging={handleDragging} blocked={blocked} settings={settings || menuVisible} closing={closingId !== null} />
      <View accessibilityElementsHidden={obscured} importantForAccessibility={obscured ? 'no-hide-descendants' : 'auto'} style={styles.content}>
        <WorkspaceHeader overview={workspace.overview} focused={focused} identity={identity} disabled={navigationBlocked || handleDragging}
          menuAnchor={menuAnchor} onSettings={openSettings} onOverview={openOverview} onMenu={openMenu} />
        <WorkspaceStage closeCheck={closeCheck} workspace={workspace} progress={progress} position={position} scrollY={scrollY} swipeY={swipeY} swipeId={swipeId} busy={busy} blocked={navigationBlocked || obscured} interactive={!handleDragging}
          pending={pendingApprovals ?? noPending} ref={overview} onHostEvent={receiveHostEvent} onFocus={focusSession} onClose={requestClose} onOpen={openSettings}
          onDragEnd={(id, close) => { runAnimation(swipeY, 0, () => { swipeId.set(null); if (close) requestClose(id); }, 140); }}
          onHandleStart={() => { setHandleDragging(true); Keyboard.dismiss(); cancelAnimation(position); }}
          onHandleEnd={onHandleEnd} />
      </View>
      {footer}
      {menuSession && <WorkspaceMenu title={menuSession.title} disabled={navigationBlocked}
        onDismiss={dismissMenu} onOverview={() => { clearMenu(); openOverview(); }}
        onSettings={() => { clearMenu(); openSettings(); }} onClose={() => { clearMenu(); requestClose(menuSession.id); }} />}
      <ClosePrompt title={workspace.sessions.find(session => session.id === closingId)?.title ?? null} onKeepOpen={keepOpen} onClose={confirmClose} onDismiss={() => overview.current?.focusCard(lastCloseId.current)} />
      <ShellSettings settings={settings} blocked={blocked} identity={identity} SettingsContent={SettingsContent}
        publishedSessions={workspace.sessions.filter(session => session.source === 'published')}
        openSettings={() => setSettings(false)} openBundledTest={openBundledTest} openFixture={openFixture}
        openPublished={openPublished} checkPublishedUpdate={checkPublishedUpdate} />
    </SafeAreaView>
  );
}

interface ShellSettingsProps {
  settings: boolean;
  blocked: boolean;
  identity?: ShellIdentity;
  SettingsContent?: ComponentType<SettingsActions>;
  publishedSessions: readonly NappletDescriptor[];
  openSettings: () => void;
  openBundledTest: () => void;
  openFixture: (variant: BundledVariant) => void;
  openPublished: SettingsActions['openPublished'];
  checkPublishedUpdate: SettingsActions['checkPublishedUpdate'];
}

function handleWorkspaceGestureEnd({ side, result, blocked, busyRef, focusedIndex, current, position, openOverview, runAnimation, change, setHandleDragging }: {
  side: HandleSide;
  result: 'overview' | 'switch' | 'cancel';
  blocked: boolean;
  busyRef: { current: boolean };
  focusedIndex: number;
  current: { current: Workspace };
  position: SharedValue<number>;
  openOverview: () => void;
  runAnimation: (value: SharedValue<number>, toValue: number, done: () => void, duration?: number) => void;
  change: (next: Workspace) => void;
  setHandleDragging: (dragging: boolean) => void;
}) {
  setHandleDragging(false);
  if (blocked || busyRef.current) return;
  if (result === 'overview') { position.set(focusedIndex); openOverview(); return; }
  const id = result === 'switch' ? adjacentNapplet(current.current, directionForHandle(side)) : null;
  const destination = id ? current.current.sessions.findIndex(session => session.id === id) : focusedIndex;
  runAnimation(position, destination, () => {
    if (id) { change(focusNapplet(current.current, id)); AccessibilityInfo.announceForAccessibility(current.current.sessions[destination].title); }
  }, 190);
}

function confirmWorkspaceNappletClose({ closingId, current, onBeforeClose, runtime, change, setClosingId, lastCloseId, overview }: {
  closingId: string | null;
  current: { current: Workspace };
  onBeforeClose?: ShellProps['onBeforeClose'];
  runtime: { discardPublished: (id: string) => void } | null;
  change: (next: Workspace) => void;
  setClosingId: (id: string | null) => void;
  lastCloseId: { current: string | null };
  overview: { current: OverviewHandle | null };
}) {
  const session = current.current.sessions.find(item => item.id === closingId);
  if (!session) return;
  onBeforeClose?.(session);
  if (session.source === 'published') runtime?.discardPublished(session.id);
  change(closeNapplet(current.current, session.id));
  setClosingId(null);
  lastCloseId.current = null;
  requestAnimationFrame(() => overview.current?.focusCard(null));
}

function ShellSettings({ settings, blocked, identity, SettingsContent, publishedSessions, openSettings, openBundledTest, openFixture, openPublished, checkPublishedUpdate }: ShellSettingsProps) {
  const { styles } = useShellStyles(createStyles);
  const settingsClose = useRef<View>(null);
  return (
    <Modal visible={settings} animationType="none" onRequestClose={() => { if (!blocked) openSettings(); }} onShow={() => {
      settingsClose.current?.focus();
      if (settingsClose.current) AccessibilityInfo.sendAccessibilityEvent(settingsClose.current, 'focus');
    }}>
      <SafeAreaProvider><SafeAreaView style={styles.settingsScreen}><ShellBackdrop mood="quiet" />
        <View style={styles.settingsHeader}><Text accessibilityRole="header" style={styles.settingsTitle}>Settings</Text><Pressable ref={settingsClose} disabled={blocked} accessibilityState={{ disabled: blocked }} accessibilityRole="button" testID="settings-done" onPress={openSettings} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable></View>
        {settings && (SettingsContent ? <SettingsContent closeSettings={openSettings} openBundledTest={openBundledTest} openStateLab={openFixture} openPublished={openPublished}
          publishedSessions={publishedSessions} checkPublishedUpdate={checkPublishedUpdate} /> : <View style={styles.settingsBody}>
          <Text selectable testID="settings-full-npub" style={styles.settingsText}>{identity ? identity.npub : 'Identity is not configured in this build.'}</Text>
          <Text accessibilityRole="header" style={styles.settingsSection}>Bundled test napplets</Text>
          <Pressable testID="settings-open-ux-lab" accessibilityRole="button" onPress={openBundledTest} style={styles.openTest}><Text style={styles.openTestText}>Open UX Lab</Text><Text style={styles.addMark} accessible={false}>+</Text></Pressable>
        </View>)}
      </SafeAreaView></SafeAreaProvider>
    </Modal>
  );
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
  settingsScreen: { flex: 1, backgroundColor: colors.background },
  settingsHeader: { minHeight: 72, paddingHorizontal: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  settingsTitle: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  done: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  doneText: { textTransform: 'uppercase', letterSpacing: 1.8, fontFamily: fonts.strong, fontSize: 14, color: colors.accent },
  settingsBody: { padding: 24, gap: 24 },
  settingsText: { fontFamily: fonts.body, color: colors.muted, fontSize: 15, lineHeight: 23 },
  settingsSection: { fontFamily: fonts.strong, color: colors.text, fontSize: 17, marginTop: 16 },
  openTest: { padding: 18, minHeight: 60, borderRadius: 0, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  openTestText: { fontFamily: fonts.body, color: colors.text, fontSize: 16 },
  addMark: { fontFamily: fonts.body, color: colors.accent, fontSize: 26 },
});
