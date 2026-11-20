import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {ReviewSlot} from './review-slot';

const empty = () => null;
const subscribe = () => empty;

/** Arm only this presentation, after its modal is visible. */
export function useReviewControl(id: string | null) {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), [id]);
  return {
    ready: id !== null && armed === id,
    onShow() {
      setArmed(null);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(id), 700);
    },
  };
}

export function usePermissionClaim(slot: ReviewSlot | undefined, lane: 'notify' | 'identity-list',
  review: {id: string | number; origin: {sessionId: string; generation: string; epoch: number}} | null) {
  const current = useSyncExternalStore(slot?.subscribe ?? subscribe, slot?.getSnapshot ?? empty);
  useEffect(() => {
    if (slot && review && !current) slot.reserve(lane, {id: String(review.id), origin: review.origin});
  }, [current, lane, review, slot]);
  useEffect(() => () => {if (review) slot?.release(lane, String(review.id));}, [lane, review, slot]);
  return !!review && (!slot || current?.lane === lane && current.item.id === String(review.id));
}
