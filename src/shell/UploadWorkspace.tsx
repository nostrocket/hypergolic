import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { UploadService, UploadPresentation } from '../uploads/upload-service.ts';
import type { Workspace } from './workspace.ts';
import { UploadSheet } from './UploadSheet';
import { UploadProgress } from './UploadProgress';
const empty: UploadPresentation = Object.freeze({current: null, pending: 0, pendingSessionIds: Object.freeze([]), active: Object.freeze([]), outcomes: Object.freeze([])});
export function useUploadPresentation(service: UploadService | undefined, epoch: number): UploadPresentation {
  const snapshot = useSyncExternalStore(useCallback(listener => service?.subscribe(listener) ?? (() => {}), [service]),
    useCallback(() => service?.getSnapshot() ?? empty, [service]));
  useEffect(() => {
    service?.revisionChanged(epoch);
    if (AppState.currentState === 'active') service?.foreground(); else service?.background();
    const listener = AppState.addEventListener('change', state => {if (state === 'active') service?.foreground(); else service?.background();});
    return () => listener.remove();
  }, [service, epoch]);
  useEffect(() => {
    if (!service || snapshot.pending + snapshot.active.length === 0) return;
    const timer = setInterval(() => service.refresh(), 250);
    return () => clearInterval(timer);
  }, [service, snapshot.pending, snapshot.active.length]);
  return snapshot;
}
export function UploadWorkspace({service, snapshot, workspace, blocked, mayReview}: {
  service: UploadService | undefined; snapshot: UploadPresentation; workspace: Workspace | undefined; blocked: boolean;
  mayReview?(id: string): boolean;
}) {
  const allowed = (id: string) => mayReview?.(id) ?? true;
  const shown = !blocked && snapshot.current && allowed(snapshot.current.id) ? snapshot.current : null;
  const title = workspace?.sessions.find(session => session.id === shown?.origin.sessionId)?.title ?? 'Napplet';
  return <>
    <UploadProgress service={service} snapshot={snapshot} workspace={workspace} blocked={blocked} reviewing={shown !== null} />
    <UploadSheet item={shown} title={title} onApprove={id => {if (allowed(id)) void service?.approve(id).catch(() => {});}} onReject={id => {if (allowed(id)) service?.reject(id);}} />
  </>;
}
