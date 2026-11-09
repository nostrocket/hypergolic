import {captureLegacyReadOnly} from '../napplets/legacy-read-only.ts';
import {decodeNativeRegistration, decodeNativeRequest, type NativeRegistration} from './capability-protocol.ts';
import type {NativeCapabilityPort} from './capability-broker.ts';
import type {ResourceHost} from '../resources/resource-broker.ts';
import {parseResourceRequest, publicResourceHttps, ResourceError, type ResourceBytes} from '../resources/resource-contract.ts';

export const LEGACY_IMAGE_MIMES: readonly string[] = Object.freeze(['image/png', 'image/gif', 'image/jpeg', 'image/webp']);
/** A separate native-attested image lane, never an ordinary Resource domain grant. */
export function createLegacyImageBroker(native: NativeCapabilityPort, host: ResourceHost,
  owner: Readonly<{registration: NativeRegistration; assertActive(): void}>) {
  const registration = decodeNativeRegistration(owner.registration), expected = JSON.stringify(registration);
  const context = registration.legacyReadOnly;
  if (!context) throw new Error('Legacy consent required');
  captureLegacyReadOnly(context, {publisher: registration.publisher, appId: registration.appId, version: registration.version,
    eventId: context.eventId, htmlHash: context.htmlHash}, registration.domains);
  const service = host.service.bind(registration, owner.assertActive), transfers = host.transfers.bind(owner.assertActive);
  let disposed = false;
  const active = (token: string): void => {
    if (disposed || !native.isActive(token)) throw new Error('Legacy image revoked');
    owner.assertActive();
  };
  return Object.freeze({
    revoke() {disposed = true; service.revoke(); transfers.revoke();},
    async dispatch(token: string): Promise<void> {
      let reply: string | null = null, type: string | undefined, id: string | undefined;
      try {
        const raw = native.take(token); if (raw === null) return;
        const captured = decodeNativeRequest(raw);
        if (JSON.stringify(captured.registration) !== expected) return;
        active(token);
        const value = captured.request as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' ||
          typeof value.id !== 'string' || !value.id || new TextEncoder().encode(value.id).length > 128) return;
        type = value.type; id = value.id;
        if (type === 'legacy.image.__chunk') {
          const result = transfers.read({...value, type: 'resource.__chunk'});
          reply = JSON.stringify({...result, type: type + '.result'});
        } else if (type === 'legacy.image.cancel') {
          const request = parseResourceRequest({...value, type: 'resource.cancel'});
          transfers.cancel(id); await service.execute(request, {nativeToken: token, assertActive: () => active(token)});
        } else if (type === 'legacy.image.bytes') {
          const request = parseResourceRequest({...value, type: 'resource.bytes'});
          if (request.type !== 'resource.bytes' || Object.keys(value).length !== 3) throw new ResourceError('invalid-request');
          // Validate with the existing URL policy. Preserve original spelling for native request/effect equality.
          publicResourceHttps(request.url);
          const result = await service.execute(request, {nativeToken: token, assertActive: () => active(token)});
          active(token);
          const image = result?.value as ResourceBytes | undefined;
          if (!image || !LEGACY_IMAGE_MIMES.includes(image.mime)) throw new ResourceError('blocked-by-policy');
          reply = JSON.stringify({type: type + '.result', id, transfer: transfers.stage(id, image)});
        }
      } catch (error) {
        if (id) try {transfers.cancel(id);} catch { /* Owner revocation already invalidates the carrier. */ }
        if (type === 'legacy.image.bytes' && id) reply = JSON.stringify({type: type + '.error', id,
          error: error instanceof ResourceError ? error.code : 'network-error'});
      } finally {
        try {active(token);} catch {reply = null;}
        try {native.finish(token, reply);} catch { /* Native lease teardown is terminal. */ }
      }
    },
  });
}
