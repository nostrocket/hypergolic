import { requireNativeModule } from 'expo';
import { createNativeApprovalPort, type ApprovalModule } from './approval-port';

export function loadNativeApprovalPort() {
  return createNativeApprovalPort(requireNativeModule<ApprovalModule>('HypergolicNappletHost'));
}
