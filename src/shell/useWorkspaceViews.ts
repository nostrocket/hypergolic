import { useEffect, useLayoutEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import type { NappletDescriptor, Workspace } from './workspace';
import { WorkspaceViews } from './workspace-views';

export function useWorkspaceViews(workspace: Workspace, managedViews: WorkspaceViews | undefined,
  runtime: RuntimeOwner | null, pendingApprovals?: ReadonlySet<string>, canCloseWithoutWarning?: (id: string) => boolean) {
  const [localViews] = useState(() => new WorkspaceViews(workspace));
  const views = managedViews ?? localViews;
  useLayoutEffect(() => {
    if (!managedViews) localViews.update(workspace);
  }, [localViews, managedViews, workspace]);
  useLayoutEffect(() => {
    const safe = (session: NappletDescriptor) => {
      try {
        return !pendingApprovals?.has(session.id) && (canCloseWithoutWarning?.(session.id) ?? true);
      } catch {
        return false;
      }
    };
    return views.bind({
      canSuspend: session => safe(session) && runtime?.canSuspend(session) === true,
      trySuspend: session => safe(session) && runtime?.trySuspend(session) === true,
    });
  }, [views, runtime, pendingApprovals, canCloseWithoutWarning]);
  useEffect(() => {
    const subscription = AppState.addEventListener('memoryWarning', () => views.trimBackground());
    return () => subscription.remove();
  }, [views]);
  return views;
}
