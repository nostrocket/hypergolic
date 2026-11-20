import { homeVisible } from './pins';
import { useEffect } from 'react';
import { BackHandler, Keyboard } from 'react-native';
import type { Workspace } from './workspace';

interface Props {
  workspace: Workspace; blocked: boolean; fullscreen: boolean; menuVisible: boolean;
  busy: Readonly<{ current: boolean }>; keyboard: Readonly<{ current: boolean }>;
  closeChecks: { isPending(): boolean };
  dismissMenu(): void; openHome(): void; openOverview(): void; focusSession(id: string): void;
}

/** Back dismisses the nearest shell surface before navigating the workspace. */
export function useWorkspaceBack({ workspace, blocked, fullscreen, menuVisible, busy, keyboard, closeChecks, dismissMenu, openHome, openOverview, focusSession }: Props) {
  const { overview, focusedId } = workspace;
  const home = homeVisible(workspace);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuVisible) { dismissMenu(); return true; }
      if (keyboard.current) { Keyboard.dismiss(); return true; }
      if (blocked || busy.current || closeChecks.isPending()) return true;
      if (fullscreen) { openOverview(); return true; }
      if (home) return false;
      if (!overview) { openHome(); return true; }
      if (focusedId) { focusSession(focusedId); return true; }
      openHome(); return true;

    });
    return () => subscription.remove();
  }, [home, openHome, blocked, busy, closeChecks, dismissMenu, focusSession, focusedId, fullscreen, keyboard, menuVisible, openOverview, overview]);
}
