import type { SharedValue } from 'react-native-reanimated';
import { Keyboard } from 'react-native';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import type { NappletDescriptor, Workspace } from './workspace';
import { useDiscoveryEntry } from './useDiscoveryEntry';

type Props = Readonly<{
  runtime: RuntimeOwner | null; workspace: Workspace; getWorkspace?: () => Workspace;
  current: Readonly<{current: Workspace}>;
  blocked: boolean; busy: boolean; dragging: boolean; settings: boolean; menu: boolean; closing: boolean;
  canNavigate(): boolean; change(workspace: Workspace): void; setSettings(open: boolean): void; openSettings(): void;
  position: SharedValue<number>; progress: SharedValue<number>; beforeClose?(session: NappletDescriptor): void;
}>;

export function useWorkspaceDiscovery(props: Props) {
  const {runtime, workspace, blocked, busy, dragging, settings, menu, closing} = props;
  const discovery = useDiscoveryEntry({runtime, workspace, beforeClose: props.beforeClose,
    getWorkspace: props.getWorkspace ?? (() => props.current.current), canNavigate: props.canNavigate,
    visible: !blocked && !busy && !dragging && !settings && !menu && !closing && !workspace.overview,
    commit: next => {
      if (!props.canNavigate()) throw new Error('Catalog navigation unavailable');
      Keyboard.dismiss();
      props.position.set(Math.max(0, next.sessions.findIndex(session => session.id === next.focusedId)));
      props.progress.set(0); props.change(next); props.setSettings(false);
    },
  });
  return {...discovery, open: () => {
    if (!props.canNavigate()) return;
    if (runtime) discovery.open(); else props.openSettings();
  }};
}
