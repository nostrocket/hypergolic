import type {HostOperationContext} from '@kehto/runtime';
import {parseConfigMessage} from '../../src/presentation/config-contract';
import {NativeRequestRevoked, type createNativeClient} from './native-client';
export function createConfigAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean) {
  return async ({message, send}: HostOperationContext): Promise<void> => {
    const request = parseConfigMessage(message), live = captureRecipient();
    try {const response = await native.config(request); if (live() && response !== null) send({...response});}
    catch (error) {
      if (!live() || error instanceof NativeRequestRevoked) return;
      if (request.type === 'config.registerSchema') {
        const error = 'Configuration schema was not applied.';
        send({type: 'config.registerSchema.result', id: request.id, ok: false, code: 'invalid-schema', error});
        send({type: 'config.schemaError', code: 'invalid-schema', error});
      }
      else if (request.type === 'config.get' || request.type === 'config.subscribe') send({type: 'config.schemaError', code: 'invalid-schema', error: 'Configuration is unavailable.'});
    }
  };
}
