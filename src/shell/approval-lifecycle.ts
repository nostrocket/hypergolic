import type { AppStateStatus } from 'react-native';
import type { ApprovalService } from '../security/approval-service.ts';

/** Match native review suspension before restoring the explicit resume control. */
export function updateApprovalAppState(service: ApprovalService, state: AppStateStatus) {
  if (state === 'active') service.foreground();
  else service.background();
}
