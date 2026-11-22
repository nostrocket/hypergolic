import {installMappletsTouchSelection, mappletsTouchStyle} from './reviewed-mapplets-touch';

/** Trusted top-document control; native calls never enter the guest namespace. */
let mediaActive = true;
let inputActive = false;
let inputAllowed = true;
let gameControls = false;
let surface: HTMLIFrameElement | null = null;
export const isRuntimeInputActive = (): boolean => inputActive;
let recipient: ((value: object) => void) | null = null;
const controlType = 'hypergolic.private.media-active';
const publish = (): void => {
  if (surface) surface.inert = !mediaActive || !inputAllowed;
  recipient?.({type:controlType,active:mediaActive,inputActive,gameControls,inputBlocked:!mediaActive || !inputAllowed});
};
Object.defineProperty(window, '__hypergolicMediaActive', {
  value(active: boolean) { mediaActive = active === true; inputActive = mediaActive && inputAllowed; publish(); }, writable: false, configurable: false,
});
Object.defineProperty(window, '__hypergolicInputActive', {
  value(active: boolean, controls = false) { gameControls = controls === true; inputAllowed = active === true; inputActive = mediaActive && inputAllowed; publish(); }, writable: false, configurable: false,
});
export function bindResourceMedia(source: Window, frame: HTMLIFrameElement, sendInputState?: (value: object) => void): Readonly<{refresh: () => void; close: () => void}> {
  recipient = value => {
    source.postMessage(value, '*');
    sendInputState?.(value);
  };
  surface = frame;
  return {refresh:publish,close(){mediaActive=false;inputActive=false;publish();recipient=null;surface=null;}};
}
function gameControlSelectors() {
  const buttons = ':is(button, [role="button"], input:is([type="button"], [type="submit"], [type="reset"]))';
  const editable = ':is(textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="button"], [type="submit"], [type="reset"]))';
  return [buttons, editable] as const;
}
/** Real-time contexts are tracked when they resume or connect their first node. */
function installWebAudioGate(isActive: () => boolean) {
  const constructor = window.AudioContext ?? (window as Window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
  const contexts = new Set<{deref(): AudioContext | undefined}>();
  const seen = new WeakSet<AudioContext>(), interrupted = new WeakSet<AudioContext>();
  if (!constructor) return {pause() {}, gesture() {}};
  const {suspend, resume} = constructor.prototype, connect = AudioNode.prototype.connect;
  function pauseContext(context: AudioContext) {
    if (context.state === 'running') interrupted.add(context);
    if (context.state !== 'closed') void suspend.call(context).catch(() => {});
  }
  function track(context: BaseAudioContext) {
    if (!(context instanceof constructor) || seen.has(context)) return;
    seen.add(context);
    for (const ref of contexts) if (!ref.deref()) contexts.delete(ref);
    const ref = typeof WeakRef === 'function' ? new WeakRef(context) : {deref:() => context};
    contexts.add(ref);
    context.addEventListener('statechange', () => {
      if (context.state === 'closed') contexts.delete(ref);
      else if (!isActive() && context.state === 'running') pauseContext(context);
    });
    if (!isActive()) pauseContext(context);
  }
  Object.defineProperty(AudioNode.prototype,'connect',{configurable:false,writable:false,value:function(this:AudioNode,...args:unknown[]) {
    track(this.context);return Reflect.apply(connect,this,args);
  }});
  Object.defineProperty(constructor.prototype,'resume',{configurable:false,writable:false,value:function(this:AudioContext) {
    track(this);
    if (!isActive() || interrupted.has(this)) return Promise.reject(new DOMException('The napplet is inactive.', 'NotAllowedError'));
    interrupted.delete(this);return resume.call(this);
  }});
  Object.defineProperty(constructor.prototype,'suspend',{configurable:false,writable:false,value:function(this:AudioContext) {
    interrupted.delete(this);return suspend.call(this);
  }});
  return {
    pause() { for (const ref of contexts) { const context=ref.deref();if(context)pauseContext(context); } },
    gesture() {
      for (const ref of contexts) {
        const context=ref.deref();
        if(context && interrupted.delete(context))void resume.call(context).catch(() => {});
      }
    },
  };
}
/** Executes before publisher scripts in the opaque guest. Captures the parent and DOM methods. */
function guestMediaGate(selectors: readonly [string, string], installAudio: typeof installWebAudioGate, installInput?: (allowed: () => boolean) => () => void): void {
  const [buttonSelector, editableSelector] = selectors;
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
  window.addEventListener('contextmenu', event => {
    if (document.documentElement.hasAttribute('data-hypergolic-game-controls') &&
        event.target instanceof Element && event.target.closest(buttonSelector) &&
        !event.target.closest(editableSelector)) event.preventDefault();
  }, true);
  const cancelInput = installInput?.(() => !inputBlocked && !inputEnded && !document.hidden);
  const prototype = HTMLMediaElement.prototype;
  const play = prototype.play, pause = prototype.pause;
  const query = Document.prototype.querySelectorAll.bind(document);
  const getPaused = Object.getOwnPropertyDescriptor(prototype, 'paused')!.get!;
  let active = false, lastGesture = -Infinity;
  const webAudio = installAudio(() => active && !inputEnded && !document.hidden);
  const now = performance.now.bind(performance);
  const gesture = (event: Event): void => { if (active && !inputBlocked && !inputEnded && event.isTrusted) {lastGesture = now();webAudio.gesture();} };
  for (const type of ['pointerdown','keydown','click']) window.addEventListener(type,gesture,true);
  const mayPlay = (): boolean => active && now() - lastGesture < 1500;
  const stop = (): void => { webAudio.pause();for (const media of query('audio,video')) pause.call(media); };
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
    document.documentElement.toggleAttribute('data-hypergolic-game-controls', data.gameControls === true);
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
  const [buttons, editable] = gameControlSelectors();
  const controls = `:root[data-hypergolic-game-controls] ${buttons}`;
  const style = `<style>${controls}:not(${editable}, ${editable} *), ${controls} :not(${editable}, ${editable} *) {
    -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important;
  }
  @layer hypergolic { ${controls}:not(${editable}, ${editable} *) { touch-action: manipulation; } }</style>`;
  return html.replace(head, value => `${value}${style}${mappletsTouch ? mappletsTouchStyle : ''}<script>(${guestMediaGate.toString()})((${gameControlSelectors.toString()})(), ${installWebAudioGate.toString()}${install ? `, ${install}` : ''});</script>`);
}
