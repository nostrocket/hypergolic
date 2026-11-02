import { getEventHash } from 'nostr-tools/pure';
import { captureUnsignedEventTemplate, type EventSnapshot } from './event-snapshot.ts';
import { validateSignedEvent, type VerifiedSignedEvent } from './signed-event.ts';

export interface NativeSignerCoreModule {
  activateEphemeralSigner(): boolean;
  generateDisposableIdentityAsync(): Promise<string>;
  reviewAndSignDisposableEventAsync(unsignedJSON: string): Promise<string>;
  cancelDisposableReviewAsync(): Promise<void>;
}

/** A disposable native review trace. It has no access to saved identities or publication. */
export async function runNativeSignerCheck(module: NativeSignerCoreModule, createdAt: number): Promise<VerifiedSignedEvent> {
  if (module.activateEphemeralSigner() !== true) throw new Error('SIGNER_UNAVAILABLE');
  const pubkey = await module.generateDisposableIdentityAsync();
  const event = captureUnsignedEventTemplate({
    kind: 1, content: 'Hypergolic native signing check',
    tags: [['t', 'hypergolic-signer-check']], created_at: createdAt,
  }, pubkey);
  const unsigned = { ...event, pubkey, tags: event.tags.map(tag => [...tag]) };
  const snapshot: EventSnapshot = Object.freeze({
    event, selectedPubkey: pubkey, destinations: Object.freeze([]), hash: getEventHash(unsigned),
  });
  const result = await module.reviewAndSignDisposableEventAsync(JSON.stringify(unsigned));
  if (typeof result !== 'string' || result.length > 16_384) throw new Error('INVALID_SIGNED_EVENT');
  return validateSignedEvent(snapshot, JSON.parse(result));
}
