const mappletsVersion = '3a5eeb98b3251a48a3ff1e32cb92ce76b7488b721dd492ae1659e90eeffe76f5';
type PublishedPin = Readonly<{published: boolean; appId: string; aggregateHash: string}>;
export function supportsMappletsTouchSelection(pin: PublishedPin): boolean {
  return pin.published && pin.appId === 'mapplets' && pin.aggregateHash === mappletsVersion;
}
export const mappletsTouchStyle = '<style>html body #map .maplibregl-canvas.is-selecting{touch-action:none}</style>';

/** Runs inside the pinned guest after its existing trusted input gate. */
export function installMappletsTouchSelection(inputAllowed: () => boolean): () => void {
  type Drag = {id: number; canvas: HTMLCanvasElement; map: HTMLElement; overlay: HTMLElement; x: number; y: number};
  const armed = '#map .maplibregl-canvas.is-selecting';
  const Mouse = MouseEvent;
  const {dispatchEvent} = EventTarget.prototype;
  const {preventDefault, stopImmediatePropagation} = Event.prototype;
  let drag: Drag | undefined;
  const emit = (target: EventTarget, type: string, clientX: number, clientY: number) => {
    dispatchEvent.call(target, new Mouse(type, {bubbles:true, cancelable:true, button:0,
      buttons:type === 'mouseup' ? 0 : 1, clientX, clientY}));
  };
  const consume = (event: TouchEvent) => {
    preventDefault.call(event);
    stopImmediatePropagation.call(event);
  };
  const current = (value: Drag) => value.canvas.isConnected && value.canvas.matches(armed) && !value.overlay.hidden;
  const cancel = () => {
    const active = drag;
    drag = undefined;
    if (!active || !current(active)) return;
    const rect = active.map.getBoundingClientRect();
    // The publisher treats a zero-size mouseup as an unfinished rectangle.
    emit(window, 'mouseup', rect.left + active.x, rect.top + active.y);
  };
  const start = (event: TouchEvent) => {
    if (!event.isTrusted || !inputAllowed()) return;
    if (drag) {consume(event);cancel();return;}
    const touch = event.touches.item(0), canvas = event.target;
    if (!event.cancelable || event.touches.length !== 1 || !touch || !(canvas instanceof HTMLCanvasElement) || !canvas.matches(armed)) return;
    const map = canvas.closest<HTMLElement>('#map'), container = canvas.parentElement;
    const overlay = map?.querySelector<HTMLElement>('.selection-rectangle');
    if (!map?.querySelector('.selection-control__button[aria-pressed="true"]') ||
        !container?.matches('.maplibregl-canvas-container') || !overlay?.hidden) return;
    const rect = map.getBoundingClientRect();
    drag = {id:touch.identifier, canvas, map, overlay, x:touch.clientX - rect.left, y:touch.clientY - rect.top};
    consume(event);
    emit(container, 'mousedown', touch.clientX, touch.clientY);
  };
  const continueDrag = (event: TouchEvent) => {
    const active = drag;
    if (!active || !event.isTrusted || !inputAllowed()) return;
    consume(event);
    const move = event.type === 'touchmove', touch = event.changedTouches.item(0);
    if (!current(active) || event.type === 'touchcancel' || event.touches.length !== (move ? 1 : 0) || touch?.identifier !== active.id) {
      cancel();return;
    }
    if (!move) drag = undefined;
    emit(window, move ? 'mousemove' : 'mouseup', touch.clientX, touch.clientY);
  };
  const capture = {capture:true, passive:false};
  window.addEventListener('touchstart', start, capture);
  for (const type of ['touchmove','touchend','touchcancel'] as const) window.addEventListener(type, continueDrag, capture);
  window.addEventListener('mousedown', event => {if (event.isTrusted) cancel();}, true);
  window.addEventListener('blur', event => {if (event.isTrusted && event.target === window) cancel();}, true);
  return cancel;
}
