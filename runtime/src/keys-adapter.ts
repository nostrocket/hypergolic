const MAX_ACTIONS = 32;
const identifier = /^[A-Za-z0-9_.:/-]{1,96}$/;
const ordinaryKey = /^[A-Za-z0-9 ]$|^Arrow(?:Left|Right|Up|Down)$/;
const modifiers = ['ctrl', 'alt', 'shift', 'meta'] as const;
const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !controls.test(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value);
}

type Action = Readonly<{id: string; binding?: string}>;
function parseAction(value: unknown): Action | null {
  const action = record(value);
  if (!action || !id(action.id) || !text(action.label, 96) || !action.label.trim()) return null;
  const suggested = Object.hasOwn(action, 'defaultKey');
  if (Object.keys(action).length !== (suggested ? 3 : 2) ||
      (suggested && !text(action.defaultKey, 48))) return null;
  const hint = action.defaultKey === 'Space' ? ' ' : action.defaultKey;
  return { id: action.id,
    ...(typeof hint === 'string' && ordinaryKey.test(hint)
      ? { binding: hint.length === 1 ? hint.toUpperCase() : hint } : {}) };
}

export function isKeysMessage(value: unknown): boolean {
  const message = record(value);
  return typeof message?.type === 'string' && message.type.startsWith('keys.');
}

/** A single verified frame owns these actions for its generation. */
export function createKeysSession(source: Window, active: () => boolean) {
  const actions = new Map<string, Action>();
  const bindings = new Set<string>();
  let closed = false;
  const send = (value: object): void => { if (!closed) source.postMessage(value, '*'); };
  const refresh = (): void => {
    const snapshot: {actionId: string; key: string}[] = [];
    for (const action of actions.values()) {
      if (action.binding !== undefined) snapshot.push({actionId: action.id, key: action.binding});
    }
    send({type: 'keys.bindings', bindings: snapshot});
  };

  function receive(value: unknown): void {
    const message = record(value);
    if (closed || !message) return;
    const size = Object.keys(message).length;
    switch (message.type) {
      case 'keys.registerAction': {
        if (!id(message.id)) return;
        const action = size === 3 ? parseAction(message.action) : null;
        const reply = {type: 'keys.registerAction.result', id: message.id, actionId: action?.id ?? ''};
        if (!action || actions.has(action.id) || actions.size >= MAX_ACTIONS) {
          send({...reply, error: !action ? 'invalid action' : actions.has(action.id) ? 'duplicate action ID' : 'too many actions'});
          return;
        }
        const binding = action.binding && !bindings.has(action.binding) ? action.binding : undefined;
        actions.set(action.id, {id: action.id, ...(binding ? {binding} : {})});
        if (binding) bindings.add(binding);
        send({...reply, ...(binding ? {binding} : {})});
        refresh();
        return;
      }
      case 'keys.unregisterAction': {
        if (size !== 2 || !id(message.actionId)) return;
        const action = actions.get(message.actionId);
        if (action?.binding) bindings.delete(action.binding);
        if (actions.delete(message.actionId)) refresh();
        return;
      }
      case 'keys.forward':
        if (!active() || size !== 7 || !text(message.key, 32) || !text(message.code, 32) ||
            !modifiers.every(name => typeof message[name] === 'boolean')) return;
        // This shell has no forwarded keyboard shortcuts. Process the event in
        // that empty shortcut scope, with no replay, logging or native dispatch.
        return;
    }
  }
  return {receive, refresh, close() { closed = true; actions.clear(); bindings.clear(); }};
}
