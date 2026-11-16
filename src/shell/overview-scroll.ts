import { clamp, type OverviewGeometry } from './motion.ts';

export function overviewScrollOffset(geometry: OverviewGeometry, index: number, top: number, height: number): number {
  const rect = geometry.cards[index];
  const bottom = rect ? rect.y + rect.height + geometry.captionHeight : 0;
  const next = !rect ? top : rect.y < top ? rect.y - 12 : bottom > top + height ? bottom - height + 12 : top;
  return clamp(next, 0, Math.max(0, geometry.contentHeight - height));
}

/** A remounted list needs both native viewport and content layout before scrolling. */
export function createOverviewScrollRestorer() {
  let layout = false;
  let content = false;
  let restored = false;
  return (event: 'layout' | 'content', restore: () => void): void => {
    if (event === 'layout') layout = true;
    if (event === 'content') content = true;
    if (restored || !layout || !content) return;
    restored = true;
    restore();
  };
}
