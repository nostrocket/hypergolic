type Edge = 'left' | 'right';
interface Touch {
  identifier: number | string;
  pageX: number;
  pageY: number;
  timestamp: number;
}
interface SwipeStart extends Touch {edge: Edge}

// Measure from the playable edge on phones with a camera cutout or a side navigation bar.
export function startFullscreenSwipe(touch: Touch, count: number, left: number, right: number): SwipeStart | null {
  if (count !== 1) return null;
  const edge = touch.pageX <= left + 32 ? 'left' : touch.pageX >= right - 32 ? 'right' : null;
  if (!edge) return null;
  const {identifier, pageX, pageY, timestamp} = touch;
  return {edge, identifier, pageX, pageY, timestamp};
}

export function finishFullscreenSwipe(start: SwipeStart | null, end: Touch): Edge | null {
  if (!start || start.identifier !== end.identifier) return null;
  const inward = (end.pageX - start.pageX) * (start.edge === 'left' ? 1 : -1);
  const elapsed = end.timestamp - start.timestamp;
  return inward >= 56 && Math.abs(end.pageY - start.pageY) <= inward / 2 && elapsed >= 0 && elapsed <= 750
    ? start.edge : null;
}
