import type { Ref } from 'react';
import { Platform, StatusBar, type ViewInstance } from 'react-native';
import { Header, type ShellIdentity } from './Header';
import type { NappletDescriptor } from './workspace';
import { useShellStyles } from './theme';

const noStyles = () => ({});
export function WorkspaceHeader({ fullscreen, overview, focused, identity, disabled, menuAnchor, onSettings, onOverview, onMenu }: {
  fullscreen: boolean; overview: boolean; focused: NappletDescriptor | undefined; identity?: ShellIdentity; disabled: boolean;
  menuAnchor: Ref<ViewInstance>; onSettings(): void; onOverview(): void; onMenu(): void;
}) {
  const { isDark } = useShellStyles(noStyles);
  const compact = !overview && focused !== undefined;
  return <>
    <StatusBar hidden={Platform.OS === 'ios' ? fullscreen : undefined} barStyle={isDark ? 'light-content' : 'dark-content'} />
    {!fullscreen && <Header title={overview ? 'Hypergolic' : focused?.title ?? 'Hypergolic'} identity={identity} disabled={disabled}
      compact={compact} menuAnchor={menuAnchor} onSettings={onSettings}
      onOverview={compact ? onOverview : undefined} onMenu={compact ? onMenu : undefined} />}
  </>;
}
