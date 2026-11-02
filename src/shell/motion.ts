export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }
export type HandleSide = 'left' | 'right';
export interface Drag { dx: number; dy: number; vx: number; vy: number; touches?: number }
export function clamp(value: number, low: number, high: number): number { 'worklet'; return Math.min(high, Math.max(low, value)); }
export function directionForHandle(side: HandleSide): -1 | 1 { 'worklet'; return side === 'left' ? -1 : 1; }
export function inwardDistance(side: HandleSide, dx: number): number { 'worklet'; return side === 'left' ? dx : -dx; }

/** Gesture decisions are in logical pixels; native/phone tuning is still required. */
export function handleRelease(side: HandleSide, drag: Drag, width: number, hasNeighbor: boolean): 'overview' | 'switch' | 'cancel' {
  'worklet';
  if ((drag.touches ?? 1) > 1) return 'cancel';
  if (Math.abs(drag.dx) < 8 && Math.abs(drag.dy) < 8) return 'overview';
  const inward = inwardDistance(side, drag.dx);
  if (!hasNeighbor || inward <= 0 || Math.abs(drag.dy) > inward * 0.75) return 'cancel';
  const threshold = clamp(width * 0.24, 64, 120);
  const velocity = side === 'left' ? drag.vx : -drag.vx;
  return inward >= threshold || (inward >= 36 && velocity >= 0.65) ? 'switch' : 'cancel';
}

/** Resistance has a finite travel; no amount of dragging wraps to another index. */
export function handlePosition(index: number, count: number, side: HandleSide, dx: number, width: number): number {
  'worklet';
  if (width <= 0 || count === 0) return index;
  const direction = directionForHandle(side);
  const inward = Math.max(0, inwardDistance(side, dx));
  const available = index + direction >= 0 && index + direction < count;
  const pixels = available ? Math.min(inward, width) : 28 * inward / (inward + 100);
  return index + direction * pixels / width;
}

export function wantsCardClose(drag: Drag): boolean {
  'worklet';
  return (drag.touches ?? 1) <= 1 && drag.dy < -12 && drag.vy < -0.6 && -drag.dy > Math.abs(drag.dx) * 1.3;
}
export function shouldCloseCard(drag: Drag): boolean {
  'worklet';
  return (drag.touches ?? 1) <= 1 && -drag.dy > Math.abs(drag.dx) * 1.3 && (drag.dy <= -72 || (drag.dy <= -32 && drag.vy < -0.8));
}

export interface OverviewGeometry { cards: readonly Rect[]; contentHeight: number; captionHeight: number }
export function overviewGeometry(size: Size, count: number, fontScale = 1): OverviewGeometry {
  const padding = 12;
  const gap = 16;
  const width = Math.max(1, (size.width - padding * 2 - gap) / 2);
  const height = size.width > 0 ? size.height * width / size.width : 1;
  const captionHeight = Math.max(48, Math.ceil(36 * fontScale));
  const header = Math.max(72, Math.ceil(56 * fontScale));
  const stride = height + captionHeight + 20;
  const cards = Array.from({ length: count }, (_, index) => ({
    x: padding + index % 2 * (width + gap),
    y: header + Math.floor(index / 2) * stride,
    width,
    height,
  }));
  return { cards, contentHeight: Math.max(size.height, header + Math.ceil(count / 2) * stride + 24), captionHeight };
}

/** Animated transforms use the default center origin, preserving the WebView aspect ratio. */
export function cardTransform(size: Size, rect: Rect): { x: number; y: number; scale: number } {
  return { x: rect.x + (rect.width - size.width) / 2, y: rect.y + (rect.height - size.height) / 2, scale: rect.width / Math.max(1, size.width) };
}

/** Gesture Handler velocities are pixels/second; classifiers use pixels/millisecond. */
export function pointerDrag(event: { translationX: number; translationY: number; velocityX: number; velocityY: number; numberOfPointers: number }, multiTouch = false): Drag {
  'worklet';
  return { dx: event.translationX, dy: event.translationY, vx: event.velocityX / 1000, vy: event.velocityY / 1000, touches: multiTouch ? 2 : event.numberOfPointers };
}

export interface CardMeasurement { expected: Rect; actual: Rect }
/** An old measurement cannot move a live view into a previous row or orientation. */
export function resolveCardRect(expected: Rect, measurement?: CardMeasurement): Rect {
  const prior = measurement?.expected;
  return prior && prior.x === expected.x && prior.y === expected.y && prior.width === expected.width && prior.height === expected.height
    ? measurement.actual : expected;
}

/** Manual activation may reset native translation; retain travel from the original touch. */
export function absolutePointerDrag(event: { absoluteX: number; absoluteY: number; velocityX: number; velocityY: number; numberOfPointers: number }, origin: { x: number; y: number }, multiTouch = false): Drag {
  'worklet';
  return pointerDrag({ translationX: event.absoluteX - origin.x, translationY: event.absoluteY - origin.y,
    velocityX: event.velocityX, velocityY: event.velocityY, numberOfPointers: event.numberOfPointers }, multiTouch);
}
