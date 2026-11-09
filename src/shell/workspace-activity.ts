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
