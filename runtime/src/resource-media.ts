import {installMappletsTouchSelection, mappletsTouchStyle} from './reviewed-mapplets-touch';

/** Trusted top-document control; native calls never enter the guest namespace. */
let mediaActive = true;
let inputActive = false;
let inputAllowed = true;
let surface: HTMLIFrameElement | null = null;
export const isRuntimeInputActive = (): boolean => inputActive;
let recipient: Window | null = null;
const controlType = 'hypergolic.private.media-active';
const publish = (): void => {
  if (surface) surface.inert = !mediaActive || !inputAllowed;
  recipient?.postMessage({type:controlType,active:mediaActive,inputActive,inputBlocked:!mediaActive || !inputAllowed}, '*');
};
Object.defineProperty(window, '__hypergolicMediaActive', {
  value(active: boolean) { mediaActive = active === true; inputActive = mediaActive && inputAllowed; publish(); }, writable: false, configurable: false,
});
Object.defineProperty(window, '__hypergolicInputActive', {
  value(active: boolean) { inputAllowed = active === true; inputActive = mediaActive && inputAllowed; publish(); }, writable: false, configurable: false,
});
export function bindResourceMedia(source: Window, frame: HTMLIFrameElement): Readonly<{refresh: () => void; close: () => void}> {
  recipient = source; surface = frame;
  return {refresh:publish,close(){mediaActive=false;inputActive=false;publish();recipient=null;surface=null;}};
}
/** Executes before publisher scripts in the opaque guest. Captures the parent and DOM methods. */
function guestMediaGate(installInput?: (allowed: () => boolean) => () => void): void {
  const owner = window.parent;
  const sourceOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source')!.get!);
  const dataOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data')!.get!);
  const targetOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Event.prototype,'target')!.get!);
  const activeElement = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Document.prototype,'activeElement')!.get!);
  const prevent = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stopEvent = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  const blur = Function.prototype.call.bind(HTMLElement.prototype.blur);
  let inputBlocked = true, inputEnded = false;
  const blockInput = (event: Event): void => {
    if (!inputBlocked || !event.isTrusted) return;
    prevent(event);
    stopEvent(event);
    try { blur(targetOf(event)); } catch { /* Native blur performs the element brand check. */ }
  };
  for (const type of ['keydown','keypress','keyup','beforeinput','input','textInput',
    'compositionstart','compositionupdate','compositionend','pointerdown','pointermove','pointerup',
    'pointerover','pointerout','pointerenter','pointerleave','pointercancel',
    'mousedown','mousemove','mouseup','mouseover','mouseout','mouseenter','mouseleave',
    'touchstart','touchmove','touchend','touchcancel','click','auxclick','dblclick','contextmenu','wheel',
    'dragstart','drag','dragend','dragenter','dragleave','dragover','drop',
    'gesturestart','gesturechange','gestureend','focusin']) {
    window.addEventListener(type,blockInput,{capture:true,passive:false});
  }
  const cancelInput = installInput?.(() => !inputBlocked && !inputEnded && !document.hidden);
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
    if (!event.isTrusted || sourceOf(event) !== owner) return;
    const data = dataOf(event);
    if (data?.type !== 'hypergolic.private.media-active' || typeof data.active !== 'boolean') return;
    active = data.active;inputBlocked = data.inputBlocked !== false;lastGesture = -Infinity;
    if (inputBlocked) {
      cancelInput?.();
      try { blur(activeElement(document)); } catch { /* Not an HTML focus target. */ }
    }
    if (!active) stop();
  }, true);
  document.addEventListener('play', event => {
    if (!mayPlay() && event.target instanceof HTMLMediaElement && !getPaused.call(event.target)) pause.call(event.target);
  }, true);
  document.addEventListener('visibilitychange', event => {
    if (document.hidden) {if (event.isTrusted) cancelInput?.();active=false;stop();}
  }, true);
  window.addEventListener('pagehide', event => {
    if (event.isTrusted) {inputEnded=true;cancelInput?.();}
    active=false;stop();
  }, true);
}
export function injectResourceMediaGate(html: string, mappletsTouch = false): string {
  const head = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!head.test(html)) throw Error('Resource gate requires the leading host CSP');
  const install = mappletsTouch ? installMappletsTouchSelection.toString() : '';
  return html.replace(head, value => `${value}${mappletsTouch ? mappletsTouchStyle : ''}<script>(${guestMediaGate.toString()})(${install});</script>`);
}
