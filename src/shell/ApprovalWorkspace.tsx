import type {CvmService} from '../cvm/cvm-service';
import {CvmReview,useCvmPresentation} from './CvmReview';
import type { ReviewSlot } from './review-slot';
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

// Public fixture workspaces can use approval without the production slot.
const emptySubscribe = () => () => undefined;
const emptySlot = () => null;


type Props = Omit<ShellProps, 'pendingApprovals' | 'onBeforeClose'> & { service: ApprovalService; uploads?: UploadService; cvm?:CvmService; reviewSlot?: ReviewSlot; epoch: number };

/** Joins trusted presentation to the native-authoritative queue without blocking the guest host. */
export function ApprovalWorkspace({ service, uploads, cvm, reviewSlot, epoch, workspace, footer, ...shell }: Props) {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const {snapshot:cvmSnapshot,shown:cvmShown}=useCvmPresentation(cvm,reviewSlot);
  const uploadSnapshot = useUploadPresentation(uploads, epoch);
  const presentation = useApprovalPresentation(service, epoch, reviewSlot);
  const {shown, held, showReceipt} = useReviewVisibility(reviewSlot, snapshot, presentation);
  const mayApprove = (id: string) => !reviewSlot || reviewSlot.owns('approval', id);
  useApprovalLifecycle(service, epoch, reviewSlot, snapshot.pending);
  const title = workspace?.sessions.find(session => session.id === shown?.origin.sessionId)?.title ?? 'Napplet';
  return <ApprovalProvider value={service}><UploadProvider value={uploads ?? null}>
    <Shell {...shell} blocked={Boolean(shell.blocked||cvmShown)} workspace={workspace} pendingApprovals={new Set([...snapshot.pendingSessionIds, ...uploadSnapshot.pendingSessionIds,...cvmSnapshot.pendingSessionIds])}
      footer={<>{!shown && !uploadSnapshot.current && !shell.blocked && <>{footer}<ApprovalResume snapshot={snapshot} service={service} /></>}<UploadWorkspace service={uploads} snapshot={uploadSnapshot} workspace={workspace} blocked={Boolean(shown || shell.blocked)} mayReview={id => !reviewSlot || reviewSlot.owns('upload', id)} /></>}
      canCloseWithoutWarning={workspaceCloseGuard({service,presentation,showReceipt,uploads,cvmPending:cvmSnapshot.pendingSessionIds,workspace})}
      onBeforeClose={session => {service.close(session.id); uploads?.close(session.id); cvm?.close(session.id); reviewSlot?.close(session.id);}} />
    {cvm&&<CvmReview service={cvm} slot={reviewSlot} workspace={workspace}/> }
    <ApprovalResults snapshot={snapshot} presentation={presentation} shown={shown!==null} showReceipt={showReceipt}/>
    <ApprovalSheet item={shown} nappletTitle={title} busy={held} error={null}
      onApprove={id => {if(mayApprove(id)&&snapshot.current?.id===id)presentation.approve(snapshot.current);}}
      onReject={id => {if(!held&&mayApprove(id))service.reject(id);}} onDismiss={id => {if(!held&&mayApprove(id))service.dismiss(id);}} />
  </UploadProvider></ApprovalProvider>;
}

function workspaceCloseGuard({service,presentation,showReceipt,uploads,cvmPending,workspace}: {
  service:ApprovalService;presentation:ReturnType<typeof useApprovalPresentation>;showReceipt:boolean;uploads?:UploadService;
  cvmPending:readonly string[];workspace:ShellProps['workspace'];
}) {
  return (id:string):boolean=>{
    if(cvmPending.includes(id)||service.hasCloseRisk(id)||presentation.busy||(showReceipt&&presentation.receipt)||presentation.outcome||uploads?.hasCloseRisk(id))return false;
    const session=workspace?.sessions.find(item=>item.id===id);
    return !(session&&uploads?.recovery?.hasUnresolvedOutcome(session.publisher,session.appId));
  };
}

function useReviewVisibility(reviewSlot: ReviewSlot | undefined, snapshot: ApprovalSnapshot,
  presentation: ReturnType<typeof useApprovalPresentation>) {
  const slot = useSyncExternalStore(reviewSlot?.subscribe ?? emptySubscribe, reviewSlot?.getSnapshot ?? emptySlot);
  const held = presentation.busy && (!reviewSlot || slot?.lane === 'approval' && slot.item.id === presentation.id);
  const candidate = held ? presentation.held : snapshot.current;
  const shown = candidate && (!reviewSlot || slot?.lane === 'approval' && slot.item.id === candidate.id) ? candidate : null;
  const showReceipt = !shown && (!reviewSlot || slot?.lane === 'approval' && slot.item.id === presentation.id);
  return {shown, held, showReceipt};
}

function useApprovalLifecycle(service: ApprovalService, epoch: number, reviewSlot: ReviewSlot | undefined, pending: number) {
  useEffect(() => {
    service.revisionChanged(epoch);
    const update = (state: typeof AppState.currentState) => {
      if (state !== 'active') reviewSlot?.setForeground(false);
      updateApprovalAppState(service, state);
      if (state === 'active') reviewSlot?.setForeground(true);
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener('change', update);
    return () => {subscription.remove(); reviewSlot?.setForeground(false);};
  }, [epoch, service, reviewSlot]);
  useEffect(() => {
    if (pending === 0) return;
    const timer = setInterval(() => service.refresh(), 250);
    return () => clearInterval(timer);
  }, [service, pending]);
}

/** Normal footer flow keeps trusted Resume outside every guest input surface. */
function ApprovalResume({snapshot,service}:{snapshot:ApprovalSnapshot;service:ApprovalService}) {
  const { styles } = useShellStyles(createStyles);
  if (!snapshot.reviewPaused || snapshot.pending === 0 || snapshot.focusedSessionId === null) return null;
  return <View style={styles.resumeArea}><Pressable testID="approval-resume" accessibilityRole="button" onPress={() => service.resume()} style={styles.resume}><Text style={styles.resumeText}>Resume approvals</Text></Pressable></View>;
}

function ApprovalResults({snapshot,presentation,shown,showReceipt}:{snapshot:ApprovalSnapshot;presentation:ReturnType<typeof useApprovalPresentation>;shown:boolean;showReceipt:boolean}){
  const { styles } = useShellStyles(createStyles);
 return <>
    {presentation.outcome && !presentation.receipt && !shown && snapshot.focusedSessionId !== null && <Pressable testID="approval-outcome" accessibilityRole="button" accessibilityLabel={`${presentation.outcome} Dismiss status`} onPress={presentation.dismissOutcome} style={styles.outcome}><Text accessibilityLiveRegion="polite" style={styles.outcomeText}>{presentation.outcome}</Text></Pressable>}
    {presentation.receipt&&showReceipt&&<PublicationReceiptSheet receipt={presentation.receipt} onDismiss={presentation.dismissReceipt}/>}
 </>;
}

const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  resumeArea: { alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 },
  resume: { minHeight: 52, borderRadius: 0, justifyContent: 'center', paddingHorizontal: 24, backgroundColor: colors.primary },
  resumeText: { fontFamily: fonts.strong, color: colors.onPrimary, fontSize: 16, },
  outcome: { position: 'absolute', left: 24, right: 24, bottom: 96, alignItems: 'center' },
  outcomeText: { fontFamily: fonts.body, color: colors.text, backgroundColor: colors.raised, borderColor: colors.border, borderWidth: 1, borderRadius: 0, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
});
