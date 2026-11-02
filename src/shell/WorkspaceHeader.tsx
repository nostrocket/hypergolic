import type { Ref } from 'react';
import { StatusBar, type View } from 'react-native';
import { Header, type ShellIdentity } from './Header';
import type { NappletDescriptor } from './workspace';
import { useShellStyles } from './theme';

const noStyles = () => ({});
export function WorkspaceHeader({ overview, focused, identity, disabled, menuAnchor, onSettings, onOverview, onMenu }: {
  overview: boolean; focused: NappletDescriptor | undefined; identity?: ShellIdentity; disabled: boolean;
  menuAnchor: Ref<View>; onSettings(): void; onOverview(): void; onMenu(): void;
}) {
  const { isDark } = useShellStyles(noStyles);
  const compact = !overview && focused !== undefined;
  return <>
    <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
    <Header title={overview ? 'Hypergolic' : focused?.title ?? 'Hypergolic'} identity={identity} disabled={disabled}
      compact={compact} menuAnchor={menuAnchor} onSettings={onSettings}
      onOverview={compact ? onOverview : undefined} onMenu={compact ? onMenu : undefined} />
  </>;
}
