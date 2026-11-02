import type { HostOperationContext } from '@kehto/runtime';
import { captureNotifyRejection, parseNotifyMessage, type NotifyMessage } from '../../src/presentation/notify-contract';
import { NativeRequestRevoked, type createNativeClient } from './native-client';
export function createNotifyAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean) {
  return async ({message, send}: HostOperationContext): Promise<void> => {
    const live = captureRecipient();
    let request: NotifyMessage;
    try {request = parseNotifyMessage(message);}
    catch {
      const rejection = captureNotifyRejection(message);
      if (live() && rejection !== null) send({...rejection});
      return;
    }
    try {const response = await native.notify(request); if (live() && response !== null) send({...response});}
    catch (error) {
      if (!live() || error instanceof NativeRequestRevoked) return;
      if (request.type === 'notify.send') send({type: 'notify.send.result', id: request.id, error: 'notification unavailable'});
      else if (request.type === 'notify.permission.request') send({type: 'notify.permission.result', id: request.id, granted: false});
    }
  };
}
