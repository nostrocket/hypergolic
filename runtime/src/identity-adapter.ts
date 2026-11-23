import type { NappletMessage } from '@kehto/runtime';
import { identityFailure, parseCapabilityRequest } from '../../src/runtime/capability-protocol';
import type { createNativeClient } from './native-client';

export function createSessionAccount(requestNative: (request: NappletMessage) => Promise<NappletMessage>,
  live: () => boolean, changed: (pubkey: string) => void) {
  let account: string | undefined;
  let accountRead: Promise<string | undefined> | undefined;
  function readAccount(id: string): Promise<string | undefined> {
    if (account !== undefined) return Promise.resolve(account);
    const request = {type:'identity.getPublicKey', id};
    accountRead ??= requestNative(request).then(response => {
      if (live() && 'pubkey' in response && typeof response.pubkey === 'string' &&
          (response.pubkey === '' || /^[0-9a-f]{64}$/.test(response.pubkey))) account ??= response.pubkey;
      return account;
    }).catch(() => account).finally(() => { accountRead = undefined; });
    return accountRead;
  }
  function update(pubkey: string): void {
    if (!live()) return;
    const previous = account;
    account = pubkey;
    if (previous !== undefined && previous !== pubkey) changed(pubkey);
  }
  return {read:readAccount, current:() => account, update};
}

export function createIdentityAdapter(native: ReturnType<typeof createNativeClient>, captureRecipient: () => () => boolean,
  readAccount: (id: string) => Promise<string | undefined>) {
  return { descriptor: { name: 'identity', version: '1.0.0' },
    handleMessage(_windowId: string, message: NappletMessage, send: (message: NappletMessage) => void): void {
      const live = captureRecipient();
      if (message.type === 'identity.getPublicKey') {
        if (!('id' in message) || typeof message.id !== 'string' || !message.id.length ||
            message.id.length > 128 || new TextEncoder().encode(message.id).length > 128) return;
        const id = message.id;
        void readAccount(id).then(pubkey => {
          if (live() && pubkey !== undefined) send({type:'identity.getPublicKey.result', id, pubkey} as NappletMessage);
        });
        return;
      }
      void native.request(message).then(response => { if (live()) send(response); }).catch(() => {
        if (!live()) return;
        try { const request = parseCapabilityRequest(message);
          if (request.type !== 'identity.getPublicKey') send(identityFailure(request, 'identity request denied') as NappletMessage);
        } catch { /* Unknown operation. */ }
      });
    } };
}
