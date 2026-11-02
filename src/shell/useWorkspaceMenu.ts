import { useCallback, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, View } from 'react-native';
import type { NappletDescriptor } from './workspace';

interface Availability {
  blocked: boolean; dragging: boolean;
  busy: Readonly<{ current: boolean }>;
  closeChecks: { isPending(): boolean };
}

/** Menu state belongs to the focused session and never survives a focus change. */
export function useWorkspaceMenu(focused: NappletDescriptor | undefined, overview: boolean, availability: Availability) {
  const [id, setId] = useState<string | null>(null);
  const anchor = useRef<View>(null);
  const session = !overview && focused?.id === id ? focused : undefined;
  const visible = session !== undefined;
  if (id !== null && !visible) setId(null);
  const dismiss = useCallback(() => {
    setId(null);
    requestAnimationFrame(() => {
      anchor.current?.focus();
      if (anchor.current) AccessibilityInfo.sendAccessibilityEvent(anchor.current, 'focus');
    });
  }, []);
  const open = () => {
    if (availability.blocked || availability.busy.current || availability.dragging || availability.closeChecks.isPending() || !focused || overview) return;
    Keyboard.dismiss();
    setId(focused.id);
  };
  return { session, visible, anchor, dismiss, open, clear: () => setId(null) };
}
