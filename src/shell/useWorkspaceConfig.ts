import {useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import {AccessibilityInfo} from 'react-native';
import type {ConfigMenuTarget, ConfigSnapshot} from '../presentation/config-broker';
import type {IdentitySession} from '../security/identity-transition';
import type {TrustedIdentityOwner} from '../security/trusted-identity-owner';
import {ShellStorageError} from '../storage/ports';
import {configMenuTarget} from './config-menu-target';
import type {NappletDescriptor, Workspace} from './workspace';

const empty: ConfigSnapshot = Object.freeze({review: null, menu: Object.freeze([])});
const emptySnapshot = () => empty;
const emptySubscription = () => () => undefined;

type MenuRequest = Readonly<{
  target: ConfigMenuTarget;
  session: IdentitySession;
  workspace: Workspace;
  controller: AbortController;
}>;

type Availability = Readonly<{blocked: boolean; dragging: boolean; settings: boolean; closing: boolean; discovery: boolean}>;

/** Hand off a user selection only after the menu has stopped obscuring the original napplet. */
export function useWorkspaceConfig(owner: TrustedIdentityOwner | null, workspace: Workspace,
  menuSession: NappletDescriptor | undefined, clearMenu: () => void, availability: Availability) {
  const service = owner?.config;
  const {menu} = useSyncExternalStore(service?.subscribe ?? emptySubscription, service?.getSnapshot ?? emptySnapshot);
  const request = useRef<MenuRequest | null>(null);
  const {blocked, dragging, settings, closing, discovery} = availability;
  const available = !blocked && !dragging && !settings && !closing && !discovery && !workspace.overview;
  const target = menuSession && configMenuTarget(menu, menuSession);

  useLayoutEffect(() => {
    const selected = request.current;
    if (!selected || !owner || !service) return;
    const {controller, session} = selected;
    const cancel = () => {
      if (request.current === selected) request.current = null;
      controller.abort();
    };
    if (!available || workspace !== selected.workspace) {cancel(); return;}
    if (menuSession) return;
    const assertSelection = () => {
      const identity = owner.transition.getSnapshot(), state = session.workspace.getSnapshot();
      if (identity.phase !== 'ready' || identity.session !== session || state.error !== null || state.workspace !== workspace) {
        throw new ShellStorageError('REVOKED');
      }
    };
    const cancelIfStale = () => {try {assertSelection();} catch {cancel();}};
    const releaseWorkspace = session.workspace.subscribe(cancelIfStale);
    const releaseIdentity = owner.transition.subscribe(cancelIfStale);
    const dispose = () => {releaseWorkspace(); releaseIdentity(); cancel();};
    const unavailable = () => {
      if (!controller.signal.aborted) AccessibilityInfo.announceForAccessibility('Napplet settings could not be opened.');
    };
    void service.openFromMenu(selected.target, controller.signal, assertSelection)
      .then(opened => {if (!opened) unavailable();}, unavailable).finally(dispose);
    return dispose;
  }, [available, menuSession, owner, service, workspace]);

  if (!owner || !target) return undefined;
  return () => {
    if (!available) return;
    const {session, phase} = owner.transition.getSnapshot(), state = session.workspace.getSnapshot();
    if (phase !== 'ready' || state.error !== null || state.workspace !== workspace) return;
    request.current?.controller.abort();
    request.current = {target, session, workspace, controller: new AbortController()};
    clearMenu();
  };
}
