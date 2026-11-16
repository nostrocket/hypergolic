import { useCallback } from 'react';
import { AccessibilityInfo, Keyboard } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { isPinned, pinKey, pinNapplet, showHome, unpinNapplet } from './pins';
import { openNapplet, type NappletDescriptor, type Workspace } from './workspace';

export function useHomeNavigation({blocked, busyRef, closeChecks, current, clearMenu, change, progress, focusSession, discover}: {
  blocked: boolean; busyRef: {current: boolean}; closeChecks: {isPending(): boolean}; current: {current: Workspace};
  clearMenu(): void; change(state: Workspace): void; progress: SharedValue<number>;
  focusSession(id: string): void; discover(): void;
}) {
  const openHome = useCallback(() => {
    if (blocked || busyRef.current || closeChecks.isPending()) return;
    Keyboard.dismiss(); clearMenu(); change(showHome(current.current)); progress.set(1);
    AccessibilityInfo.announceForAccessibility('Home');
  }, [blocked, busyRef, change, clearMenu, closeChecks, current, progress]);
  const openPin = (pin: NappletDescriptor) => {
    if (blocked) return;
    if (pin.source === 'bundled' && pin.appId === 'napplet-discovery') { discover(); return; }
    const existing = current.current.sessions.find(session => pinKey(session) === pinKey(pin));
    if (existing) { focusSession(existing.id); return; }
    if (current.current.sessions.length >= 64) { AccessibilityInfo.announceForAccessibility('Close a napplet before opening another.'); return; }
    change(openNapplet(current.current, pin));
  };
  const togglePin = (pin: NappletDescriptor) => {
    if (blocked) return;
    try {
      const removing = isPinned(current.current, pin);
      change(removing ? unpinNapplet(current.current, pin) : pinNapplet(current.current, pin));
      AccessibilityInfo.announceForAccessibility(removing ? 'Unpinned from Home' : 'Pinned to Home'); clearMenu();
    } catch { AccessibilityInfo.announceForAccessibility('Your Home is full. Unpin a napplet first.'); }
  };
  const unpin = (pin: NappletDescriptor) => { if (!blocked) change(unpinNapplet(current.current, pin)); };
  return {openHome, openPin, togglePin, unpin};
}
