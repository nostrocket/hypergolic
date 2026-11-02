import type { Drag } from './motion';

export interface CardTouchOrigin { id: number; x: number; y: number; time: number }
export interface CardTouchPoint { id: number; absoluteX: number; absoluteY: number }

/** Manual gestures preserve the pointer and travel from the original down event. */
export function cardDragFromTouch(origin: CardTouchOrigin | null, point: CardTouchPoint | undefined, now: number, touches: number): Drag | null {
  'worklet';
  if (!origin || !point || touches !== 1 || point.id !== origin.id) return null;
  const elapsed = Math.max(1, now - origin.time);
  const dx = point.absoluteX - origin.x;
  const dy = point.absoluteY - origin.y;
  return { dx, dy, vx: dx / elapsed, vy: dy / elapsed, touches: 1 };
}

/** Both native implementations decrement numberOfTouches before the UP callback. */
export function releasedCardTouch(origin: CardTouchOrigin | null, changed: readonly CardTouchPoint[], remainingTouches: number, now: number, cancelled: boolean): Drag | null {
  'worklet';
  if (cancelled || remainingTouches !== 0 || changed.length !== 1) return null;
  return cardDragFromTouch(origin, changed[0], now, 1);
}

/** Native tap distance checks may omit the final UP position; check it independently. */
export function isCardTapRelease(origin: CardTouchPoint | null, changed: readonly CardTouchPoint[], remainingTouches: number): boolean {
  'worklet';
  const point = changed.length === 1 ? changed[0] : undefined;
  if (!origin || !point || remainingTouches !== 0 || point.id !== origin.id) return false;
  const dx = point.absoluteX - origin.absoluteX, dy = point.absoluteY - origin.absoluteY;
  return Number.isFinite(dx) && Number.isFinite(dy) && dx * dx + dy * dy <= 64;
}
