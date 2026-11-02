import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { WorkspaceController } from '../storage/workspace-controller';
import type { ShellIdentity } from './Header';
import { Shell, type SettingsActions } from './Shell';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import type { UploadService } from '../uploads/upload-service';
import type { ApprovalService } from '../security/approval-service';
import { useShellStyles, type ShellPalette, type ShellFonts } from './theme';

interface Props { identity: ShellIdentity; controller: WorkspaceController; blocked?: boolean; settingsComponent?: ComponentType<SettingsActions>; approvals?: ApprovalService; uploads?: UploadService; epoch: number; footer?: ReactNode }
export function WorkspaceEntry({ identity, controller, blocked, settingsComponent, approvals, uploads, epoch, footer }: Props) {
  const { styles } = useShellStyles(createStyles);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <View style={styles.screen} collapsable={false} testID={state.saving ? 'workspace-saving' : 'workspace-saved'}>
    {approvals ? <ApprovalWorkspace service={approvals} uploads={uploads} epoch={epoch} identity={identity} footer={footer} blocked={blocked} settingsComponent={settingsComponent} workspace={state.workspace} onWorkspaceChange={controller.change} />
      : <Shell identity={identity} footer={footer} blocked={blocked} settingsComponent={settingsComponent} workspace={state.workspace} onWorkspaceChange={controller.change} />}
    <Modal visible={state.error !== null} animationType="none" onRequestClose={() => undefined}>
      <SafeAreaProvider><SafeAreaView style={styles.problem}>
        <Text accessibilityRole="header" style={styles.heading}>Workspace changes could not be saved</Text>
        <Text style={styles.detail}>Your open napplets are still loaded. Restart the app to reopen your workspace from saved data.</Text>
      </SafeAreaView></SafeAreaProvider>
    </Modal>
  </View>;
}
const createStyles = (colors: ShellPalette, fonts: ShellFonts) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  problem: { flex: 1, justifyContent: 'center', padding: 32, gap: 18, backgroundColor: colors.background },
  heading: { fontFamily: fonts.display, color: colors.text, fontSize: 28, },
  detail: { fontFamily: fonts.body, color: colors.muted, fontSize: 16, lineHeight: 24 },
});
