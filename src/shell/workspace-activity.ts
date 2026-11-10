import type { Workspace } from './workspace.ts';

/** Native window bounds follow OS rotation. The stage can shrink independently for the keyboard. */
export function isWorkspaceFullscreen(workspace: Pick<Workspace, 'focusedId' | 'overview'>, window: {width: number; height: number}): boolean {
  return workspace.focusedId !== null && !workspace.overview && window.height > 0 && window.width > window.height;
}

/** Review input occlusion is separate from changing the committed native source. */
export function workspaceSessionActivity(context: Readonly<{
  focused: boolean; overview: boolean; busy: boolean; interactive: boolean; checkingClose: boolean;
  blocked: boolean; hostActivityBlocked: boolean;
}>): Readonly<{active: boolean; inputBlocked: boolean}> {
  const active = context.focused && !context.overview && !context.busy &&
    context.interactive && !context.checkingClose && !context.hostActivityBlocked;
  return {active, inputBlocked: !active || context.blocked};
}

export function isHostActivityBlocked(blocked: boolean, obscured: boolean): boolean {
  return blocked || obscured;
}
