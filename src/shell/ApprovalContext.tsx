import { createContext, useContext } from 'react';
import type { ApprovalService } from '../security/approval-service.ts';

export const ApprovalContext = createContext<ApprovalService | null>(null);
export const ApprovalProvider = ApprovalContext.Provider;

export function useApprovalService(): ApprovalService | null {
  return useContext(ApprovalContext);
}
