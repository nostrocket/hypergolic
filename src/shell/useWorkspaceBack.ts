import { useEffect } from 'react';
import { BackHandler, Keyboard } from 'react-native';
import type { Workspace } from './workspace';

interface Props {
  workspace: Workspace; blocked: boolean; menuVisible: boolean;
  busy: Readonly<{ current: boolean }>; keyboard: Readonly<{ current: boolean }>;
  closeChecks: { isPending(): boolean };
  dismissMenu(): void; openOverview(): void; focusSession(id: string): void;
}

/** Back dismisses the nearest shell surface before navigating the workspace. */
export function useWorkspaceBack({ workspace, blocked, menuVisible, busy, keyboard, closeChecks, dismissMenu, openOverview, focusSession }: Props) {
  const { overview, focusedId } = workspace;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuVisible) { dismissMenu(); return true; }
      if (keyboard.current) { Keyboard.dismiss(); return true; }
      if (blocked || busy.current || closeChecks.isPending()) return true;
      if (!overview) { openOverview(); return true; }
      if (focusedId) { focusSession(focusedId); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [blocked, busy, closeChecks, dismissMenu, focusSession, focusedId, keyboard, menuVisible, openOverview, overview]);
}
