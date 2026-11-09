import type { MediaAction, MediaEvent, MediaState } from './media-wire';

/** Serialized before Kehto initializes its granted namespace. Only the exact parent can deliver. */
function installMediaFacade(): void {
  const guest = window as Window & {napplet?: {shell?: {ready(): Promise<unknown>}; media?: object}};
  const parentWindow = window.parent;
  const post = parentWindow.postMessage.bind(parentWindow);
  type Handler = (message: unknown) => void;
  type Topic = 'media.state' | 'media.capabilities' | 'media.session.ended';
  const pending = new Map<string, (message: unknown) => void>();
  const sessions = new Map<string, {ended: boolean; latest: Map<Topic, unknown>; handlers: Map<Topic, Set<Handler>>}>();
  const notify = (handler: Handler, value: unknown): void => { try { handler(value); } catch { /* Guest callbacks are independent. */ } };
  const subscribe = (sessionId: string, type: Topic, handler: Handler) => {
    if (typeof handler !== 'function') throw new TypeError('Invalid media listener');
    const session = sessions.get(sessionId);
    if (!session || session.ended && type !== 'media.session.ended') return {close() {}};
    const handlers = session.handlers.get(type) ?? new Set<Handler>();
    if (handlers.size >= 16) throw new Error('Too many media listeners');
    session.handlers.set(type, handlers);
    handlers.add(handler);
    if (session.latest.has(type)) notify(handler, session.latest.get(type));
    return {close() {handlers.delete(handler);}};
  };
  const receive = (event: MessageEvent): void => {
    if (!event.isTrusted || event.source !== parentWindow || typeof event.data?.type !== 'string') return;
    const message = event.data as MediaEvent;
    if (message.type === 'media.session.create.result') {
      const resolve = pending.get(message.id);
      if (!resolve) return;
      if (message.sessionId && message.owner === 'shell') sessions.set(message.sessionId, {ended:false,latest:new Map(),handlers:new Map()});
      resolve(message.error ? {error:message.error} : {sessionId:message.sessionId,owner:message.owner});
      return;
    }
    if (message.type !== 'media.state' && message.type !== 'media.capabilities' && message.type !== 'media.session.ended') return;
    const session = sessions.get(message.sessionId);
    if (!session || session.ended) return;
    const {type, sessionId: _sessionId, ...state} = message;
    const value = message.type === 'media.capabilities' ? Object.freeze([...message.actions]) :
      message.type === 'media.session.ended' ? Object.freeze({sessionId:_sessionId, reason:message.reason}) : Object.freeze(state);
    const handlers = Array.from(session.handlers.get(type) ?? []);
    if (type === 'media.session.ended') {session.ended = true; session.handlers.clear(); session.latest.clear();}
    session.latest.set(type, value);
    for (const handler of handlers) notify(handler, value);
  };
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', () => {
    window.removeEventListener('message', receive);
    for (const resolve of pending.values()) resolve({error:'Media endpoint closed.'});
    sessions.clear();
  }, {once:true});
  const sendCommand = (sessionId: string, action: MediaAction, value?: number): void => {
    post({type:'media.command', sessionId, action, ...(value === undefined ? {} : {value})}, '*');
  };
  const facade = Object.freeze({
    createSession(options: object) {
      if (pending.size >= 4 || sessions.size >= 64) return Promise.resolve({error:'Media session limit exceeded.'});
      const random = crypto.getRandomValues(new Uint8Array(16));
      const id = 'media-' + Array.from(random, value => value.toString(16).padStart(2,'0')).join('');
      return new Promise(resolve => {
        const settle = (message: unknown) => {pending.delete(id); clearTimeout(timeout); resolve(message);};
        const timeout = setTimeout(() => settle({error:'Media session creation timed out.'}), 8000);
        pending.set(id, settle);
        void Promise.resolve().then(() => guest.napplet?.shell?.ready()).then(() => {
          if (pending.has(id)) post({...options, type:'media.session.create', id}, '*');
        }).catch(() => settle({error:'Invalid media request.'}));
      });
    },
    destroySession: (sessionId: string) => post({type:'media.session.destroy',sessionId}, '*'),
    updateSession: (sessionId: string, metadata: object) => post({type:'media.session.update',sessionId,metadata}, '*'),
    sendCommand,
    command: (sessionId: string, command: {action:MediaAction; value?:number}) => sendCommand(sessionId, command.action, command.value),
    onState: (sessionId: string, handler: (state: MediaState) => void) => subscribe(sessionId,'media.state',handler as Handler),
    onCapabilities: (sessionId: string, handler: Handler) => subscribe(sessionId,'media.capabilities',handler),
    onEnded: (sessionId: string, handler: Handler) => subscribe(sessionId,'media.session.ended',handler),
    onCommand: () => ({close() {}}),
    onControls: () => ({close() {}}),
  });
  guest.napplet = {media:facade};
}

export function injectMediaFacade(html: string): string {
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw Error('Media binding requires the leading host CSP');
  return html.replace(head, value => `${value}<script>(${installMediaFacade.toString()})();</script>`);
}
