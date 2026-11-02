import type { SharedValue } from 'react-native-reanimated';
import type { RuntimeOwner } from '../runtime/runtime-owner';
import type { NappletConsentReview } from '../napplets/first-open-consent';
import type { SettingsActions } from './Shell';
import { openNapplet, replacePublishedNapplet, type NappletDescriptor, type Workspace } from './workspace';

/** Verified publication actions share workspace navigation without changing host authority. */
export function publishedSettingsActions({ runtime, blocked, getWorkspace, position, progress, change, setSettings, onBeforeClose }: {
  runtime: RuntimeOwner | null; blocked: boolean; getWorkspace(): Workspace;
  position: SharedValue<number>; progress: SharedValue<number>;
  change(workspace: Workspace): void; setSettings(open: boolean): void;
  onBeforeClose?: (session: NappletDescriptor) => void;
}): Pick<SettingsActions, 'openPublished' | 'checkPublishedUpdate'> {
  const openPublished = async (link: string, signal: AbortSignal, review: (request: NappletConsentReview) => Promise<boolean>) => {
    if (!runtime || blocked || signal.aborted || getWorkspace().sessions.length >= 64) throw new Error('Published napplet unavailable');
    const descriptor = await runtime.openPublishedLink(link, signal, review);
    if (signal.aborted || blocked) { runtime.discardPublished(descriptor.id); throw new Error('Published napplet cancelled'); }
    const next = openNapplet(getWorkspace(), descriptor);
    position.set(next.sessions.length - 1);
    progress.set(0);
    change(next);
    setSettings(false);
  };
  const checkPublishedUpdate: SettingsActions['checkPublishedUpdate'] = async (session, signal, reviewUpdate, reviewConsent) => {
    if (!runtime || blocked || signal.aborted) throw new Error('Published update unavailable');
    const descriptor = await runtime.preparePublishedUpdate(session, signal, reviewUpdate, reviewConsent);
    if (!descriptor) return false;
    if (signal.aborted || blocked) { runtime.discardPublished(descriptor.id); throw new Error('Published update cancelled'); }
    let next: Workspace;
    try { next = replacePublishedNapplet(getWorkspace(), session.id, descriptor); }
    catch (error) { runtime.discardPublished(descriptor.id); throw error; }
    try { onBeforeClose?.(session); }
    catch (error) { runtime.discardPublished(descriptor.id); throw error; }
    runtime.discardPublished(session.id);
    position.set(next.sessions.findIndex(item => item.id === descriptor.id));
    progress.set(0);
    change(next);
    setSettings(false);
    return true;
  };
  return { openPublished, checkPublishedUpdate };
}
