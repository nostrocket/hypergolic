import type { NappletMessage } from '@kehto/runtime';
import { identityFailure, identityResult, parseCapabilityRequest } from '../../src/runtime/capability-protocol.ts';
import type { createNativeClient } from './native-client';

export function identityAdapter(native: Pick<ReturnType<typeof createNativeClient>, 'request'>, captureRecipient: () => () => boolean) {
  return {
    descriptor: {name: 'identity', version: '1.0.0'},
    handleMessage(_windowId: string, message: NappletMessage, send: (message: NappletMessage) => void) {
      const live = captureRecipient();
      void native.request(message).then(response => {
        if (live()) send(response);
      }).catch(() => {
        if (!live()) return;
        try {
          const request = parseCapabilityRequest(message);
          send((request.type === 'identity.getPublicKey' ? identityResult(request, '') : identityFailure(request, 'identity request denied')) as NappletMessage);
        } catch { /* Unknown operation. */ }
      });
    },
  };
}
