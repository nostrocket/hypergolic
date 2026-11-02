import { useEffect } from 'react';
import { useUploadService } from './UploadContext';
import { useApprovalService } from './ApprovalContext';

type Props = Readonly<{
  sessionId: string | null;
  overview: boolean;
  busy: boolean;
  dragging: boolean;
  blocked: boolean;
  settings: boolean;
  closing: boolean;
}>;

/** Synchronizes trusted review eligibility after the shell has committed visibility. */
export function ReviewFocus({ sessionId, overview, busy, dragging, blocked, settings, closing }: Props) {
  const service = useApprovalService();
  const uploads = useUploadService();
  const visible = !overview && !busy && !dragging && !blocked && !settings && !closing;
  useEffect(() => {
    service?.focus(visible ? sessionId : null);
    uploads?.focus(visible ? sessionId : null);
  }, [service, uploads, sessionId, visible]);
  return null;
}
