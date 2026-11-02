import {PublicationReceiptSheet} from './PublicationReceiptSheet';
import {useApprovalPresentation} from './useApprovalPresentation';
import type { UploadService } from '../uploads/upload-service.ts';
import { UploadProvider } from './UploadContext';
import { UploadWorkspace, useUploadPresentation } from './UploadWorkspace';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { ShellPressable as Pressable } from './ShellPressable';
import type { ApprovalService, ApprovalSnapshot } from '../security/approval-service.ts';
import { ApprovalSheet } from './ApprovalSheet';
import { updateApprovalAppState } from './approval-lifecycle.ts';
import { ApprovalProvider } from './ApprovalContext';
import { Shell, type ShellProps } from './Shell';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

type Props = Omit<ShellProps, 'pendingApprovals' | 'onBeforeClose'> & { service: ApprovalService; uploads?: UploadService; epoch: number };

/** Joins trusted presentation to the native-authoritative queue without blocking the guest host. */
export function ApprovalWorkspace({ service, uploads, epoch, workspace, footer, ...shell }: Props) {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const uploadSnapshot = useUploadPresentation(uploads, epoch);
  const presentation=useApprovalPresentation(service,epoch);
  const shown=presentation.busy ? presentation.held : snapshot.current;
  useEffect(() => {
    service.revisionChanged(epoch);
    updateApprovalAppState(service, AppState.currentState);
    const subscription = AppState.addEventListener('change', state => updateApprovalAppState(service, state));
    return () => subscription.remove();
  }, [epoch, service]);
  useEffect(() => {
    if (snapshot.pending === 0) return;
    const timer = setInterval(() => service.refresh(), 250);
    return () => clearInterval(timer);
  }, [service, snapshot.pending]);
  const title = workspace?.sessions.find(session => session.id === shown?.origin.sessionId)?.title ?? 'Napplet';
  return <ApprovalProvider value={service}><UploadProvider value={uploads ?? null}>
    <Shell {...shell} workspace={workspace} pendingApprovals={new Set([...snapshot.pendingSessionIds, ...uploadSnapshot.pendingSessionIds])}
      footer={<>{!shown && !uploadSnapshot.current && !shell.blocked && <>{footer}<ApprovalResume snapshot={snapshot} service={service} /></>}<UploadWorkspace service={uploads} snapshot={uploadSnapshot} workspace={workspace} blocked={Boolean(shown || shell.blocked)} /></>}
      canCloseWithoutWarning={id => {
        if (service.hasCloseRisk(id) || presentation.busy || presentation.receipt || presentation.outcome || uploads?.hasCloseRisk(id)) return false;
        const session = workspace?.sessions.find(item => item.id === id);
        if (session && uploads?.recovery?.hasUnresolvedOutcome(session.publisher, session.appId)) return false;
        return true;
      }}
      onBeforeClose={session => {service.close(session.id); uploads?.close(session.id);}} />
    <ApprovalResults snapshot={snapshot} presentation={presentation} shown={shown!==null}/>
    <ApprovalSheet item={shown} nappletTitle={title} busy={presentation.busy} error={null}
      onApprove={id => {if(snapshot.current?.id===id)presentation.approve(snapshot.current);}}
      onReject={id => {if(!presentation.busy)service.reject(id);}} onDismiss={id => {if(!presentation.busy)service.dismiss(id);}} />
  </UploadProvider></ApprovalProvider>;
}

/** Normal footer flow keeps trusted Resume outside every guest input surface. */
function ApprovalResume({snapshot,service}:{snapshot:ApprovalSnapshot;service:ApprovalService}) {
  const { styles } = useShellStyles(createStyles);
  if (!snapshot.reviewPaused || snapshot.pending === 0 || snapshot.focusedSessionId === null) return null;
  return <View style={styles.resumeArea}><Pressable testID="approval-resume" accessibilityRole="button" onPress={() => service.resume()} style={styles.resume}><Text style={styles.resumeText}>Resume approvals</Text></Pressable></View>;
}

function ApprovalResults({snapshot,presentation,shown}:{snapshot:ApprovalSnapshot;presentation:ReturnType<typeof useApprovalPresentation>;shown:boolean}){
  const { styles } = useShellStyles(createStyles);
 return <>
    {presentation.outcome && !presentation.receipt && !shown && snapshot.focusedSessionId !== null && <Pressable testID="approval-outcome" accessibilityRole="button" accessibilityLabel={`${presentation.outcome} Dismiss status`} onPress={presentation.dismissOutcome} style={styles.outcome}><Text accessibilityLiveRegion="polite" style={styles.outcomeText}>{presentation.outcome}</Text></Pressable>}
    {presentation.receipt&&!shown&&<PublicationReceiptSheet receipt={presentation.receipt} onDismiss={presentation.dismissReceipt}/>}
 </>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  resumeArea: { alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 },
  resume: { minHeight: 52, borderRadius: 0, justifyContent: 'center', paddingHorizontal: 24, backgroundColor: colors.primary },
  resumeText: { fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 16, },
  outcome: { position: 'absolute', left: 24, right: 24, bottom: 96, alignItems: 'center' },
  outcomeText: { fontFamily: fonts.body, color: colors.text, backgroundColor: colors.raised, borderColor: colors.border, borderWidth: 1, borderRadius: 0, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
});
