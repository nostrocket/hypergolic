import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import { DISCOVERY_PUBLICATION_ADDRESS } from '../napplets/discovery-publication';
import { createDiscoveryController } from '../napplets/discovery-controller';
import { isDiscoveryEntry } from '../napplets/discovery-entry';
import type { NappletDescriptor, Workspace } from './workspace';

type Props = Readonly<{
  runtime: RuntimeOwner | null; workspace: Workspace; visible: boolean;
  getWorkspace(): Workspace; canNavigate(): boolean;
  commit(workspace: Workspace): void; beforeClose?(session: NappletDescriptor): void;
}>;

function createReviewQueue() {
  let pending: {request: NappletConsentReview; resolve(accepted: boolean): void} | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const decide = (accepted: boolean, request: NappletConsentReview | null) => {
    if (!pending || pending.request !== request) return;
    const {resolve} = pending;
    pending = null;
    resolve(accepted);
    publish();
  };
  return {
    getSnapshot: () => pending?.request ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    ask(request: NappletConsentReview) {
      return new Promise<boolean>(resolve => {
        if (pending) { resolve(false); return; }
        pending = {request, resolve};
        publish();
      });
    },
    decide,
    cancel() { if (pending) decide(false, pending.request); },
  };
}

/** Refresh once per catalog activation, and again when the app returns to foreground. */
export function useDiscoveryEntry(props: Props) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; }, [props]);
  const [reviews] = useState(createReviewQueue);
  const review = useSyncExternalStore(reviews.subscribe, reviews.getSnapshot);
  const foreground = useRef(AppState.currentState === 'active');
  const controller = useRef<ReturnType<typeof createDiscoveryController> | null>(null);
  const {runtime} = props;
  useLayoutEffect(() => {
    if (!runtime) return;
    const entry = createDiscoveryController({
      address: DISCOVERY_PUBLICATION_ADDRESS,
      workspace: () => latest.current.getWorkspace(),
      visible: () => latest.current.runtime === runtime && latest.current.visible && foreground.current && latest.current.canNavigate(),
      bundled: () => runtime.descriptor('napplet-discovery', 1),
      commit: next => latest.current.commit(next),
      openPublished: (...args) => runtime.openPublishedLink(...args),
      updatePublished: (...args) => runtime.preparePublishedUpdate(...args),
      discard: id => runtime.discardPublished(id),
      beforeClose: session => latest.current.beforeClose?.(session),
      review: reviews.ask,
      unavailable: () => AccessibilityInfo.announceForAccessibility('The catalog update is unavailable. Your current catalog is still open.'),
    });
    controller.current = entry;
    return () => {
      controller.current = null;
      entry.dispose();
      reviews.cancel();
    };
  }, [runtime, reviews]);
  const focused = props.workspace.sessions.find(session => session.id === props.workspace.focusedId);
  const selected = props.visible && focused && isDiscoveryEntry(focused) ? focused.id : null;
  useEffect(() => {
    if (selected) void controller.current?.refresh();
    else { controller.current?.cancel(); reviews.cancel(); }
  }, [runtime, reviews, selected]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const wasActive = foreground.current;
      foreground.current = state === 'active';
      if (!foreground.current) { controller.current?.cancel(); reviews.cancel(); }
      else if (!wasActive) void controller.current?.refresh();
    });
    return () => subscription.remove();
  }, [reviews]);
  return {open: () => controller.current?.open(), review, decide: (accepted: boolean) => reviews.decide(accepted, review)};
}
