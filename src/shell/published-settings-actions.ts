import type { SharedValue } from 'react-native-reanimated';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import type { PublishedUpdateReview } from '../napplets/published-session';
import { openNapplet, replacePublishedNapplet, samePublishedPin, type NappletDescriptor, type Workspace } from './workspace.ts';

/** Verified publication actions share workspace navigation without changing host authority. */
export function publishedSettingsActions({ runtime, blocked, getWorkspace, position, progress, change, setSettings, onBeforeClose }: {
  runtime: Pick<RuntimeOwner, 'openPublishedLink' | 'preparePublishedUpdate' | 'discardPublished'> | null;
  blocked: boolean; getWorkspace(): Workspace;
  position: Pick<SharedValue<number>, 'set'>; progress: Pick<SharedValue<number>, 'set'>;
  change(workspace: Workspace): void; setSettings(open: boolean): void;
  onBeforeClose?: (session: NappletDescriptor) => void;
}) {
  const commit = (descriptor: NappletDescriptor, signal: AbortSignal, previous?: NappletDescriptor) => {
    if (!runtime) throw new Error('Published napplet unavailable');
    let transferred = false;
    try {
      if (signal.aborted || blocked) throw new Error('Published napplet cancelled');
      const workspace = getWorkspace();
      if (!previous && workspace.sessions.length >= 64) throw new Error('Published napplet unavailable');
      const next = previous ? replacePublishedNapplet(workspace, previous.id, descriptor) : openNapplet(workspace, descriptor);
      if (previous) onBeforeClose?.(previous);
      change(next);
      // A frozen or failed controller may decline the synchronous change.
      const index = getWorkspace().sessions.findIndex(session => samePublishedPin(session, descriptor));
      if (index < 0) throw new Error('Published napplet could not be added to the workspace');
      transferred = true;
      if (previous) runtime.discardPublished(previous.id);
      position.set(index);
      progress.set(0);
      setSettings(false);
    } finally {
      if (!transferred) runtime.discardPublished(descriptor.id);
    }
  };
  const openPublished = async (link: string, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) => {
    if (!runtime || blocked || signal.aborted || getWorkspace().sessions.length >= 64) throw new Error('Published napplet unavailable');
    const descriptor = await runtime.openPublishedLink(link, signal, review);
    commit(descriptor, signal);
  };
  const checkPublishedUpdate = async (session: NappletDescriptor, signal: AbortSignal,
    reviewUpdate: (request: PublishedUpdateReview) => Promise<boolean>,
    reviewConsent: (request: NappletConsentReview) => Promise<boolean>) => {
    if (!runtime || blocked || signal.aborted) throw new Error('Published update unavailable');
    const descriptor = await runtime.preparePublishedUpdate(session, signal, reviewUpdate, reviewConsent);
    if (!descriptor) return false;
    commit(descriptor, signal, session);
    return true;
  };
  return { openPublished, checkPublishedUpdate };
}
