/** Trusted top-document control; native calls never enter the guest namespace. */
let mediaActive = true;
let recipient: Window | null = null;
const controlType = 'hypergolic.private.media-active';
const publish = (): void => { recipient?.postMessage({type:controlType,active:mediaActive}, '*'); };
Object.defineProperty(window, '__hypergolicMediaActive', {
  value(active: boolean) { mediaActive = active === true; publish(); }, writable: false, configurable: false,
});
export function bindResourceMedia(source: Window): Readonly<{refresh: () => void; close: () => void}> {
  recipient = source;
  return {refresh:publish,close(){mediaActive=false;publish();recipient=null;}};
}
/** Executes before publisher scripts in the opaque guest. Captures the parent and DOM methods. */
function guestMediaGate(): void {
  const owner = window.parent;
  const prototype = HTMLMediaElement.prototype;
  const play = prototype.play, pause = prototype.pause;
  const query = Document.prototype.querySelectorAll.bind(document);
  const getPaused = Object.getOwnPropertyDescriptor(prototype, 'paused')!.get!;
  let active = false, lastGesture = -Infinity;
  const now = performance.now.bind(performance);
  const gesture = (event: Event): void => { if (active && event.isTrusted) lastGesture = now(); };
  for (const type of ['pointerdown','keydown','click']) window.addEventListener(type,gesture,true);
  const mayPlay = (): boolean => active && now() - lastGesture < 1500;
  const stop = (): void => { for (const media of query('audio,video')) pause.call(media); };
  Object.defineProperty(prototype, 'play', {configurable:false,writable:false,value:function(this:HTMLMediaElement){
    if (!mayPlay()) return Promise.reject(new DOMException('The napplet is inactive.', 'NotAllowedError'));
    return play.call(this);
  }});
  window.addEventListener('message', event => {
    if (!event.isTrusted || event.source !== owner || event.data?.type !== 'hypergolic.private.media-active' || typeof event.data.active !== 'boolean') return;
    active = event.data.active;lastGesture = -Infinity;
    if (!active) stop();
  }, true);
  document.addEventListener('play', event => {
    if (!mayPlay() && event.target instanceof HTMLMediaElement && !getPaused.call(event.target)) pause.call(event.target);
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) {active=false;stop();} }, true);
  window.addEventListener('pagehide', () => {active=false;stop();}, true);
}
export function injectResourceMediaGate(html: string): string {
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw Error('Resource gate requires the leading host CSP');
  return html.replace(head, value => `${value}<script>(${guestMediaGate.toString()})();</script>`);
}
