import { parseResourceRequest, resourceFailure, ResourceError, type ResourceBytes } from './resource-contract.ts';
import type { ResourceAuthority, createResourceService } from './resource-service.ts';
import type { ResourceTransferPool } from './resource-transfers.ts';
import type { CapabilityOwner } from '../runtime/capability-broker.ts';

export type ResourceService = ReturnType<typeof createResourceService>;
export interface ResourceHost { service: ResourceService; transfers: ResourceTransferPool }
/** Captures the registered realm once. No public payload can select storage, identity or a recipient. */
export function createResourceBroker(host: ResourceHost, owner: CapabilityOwner) {
  const service = host.service.bind(owner.registration, owner.assertActive);
  const transfers = host.transfers.bind(owner.assertActive);
  return Object.freeze({
    revoke(): void { transfers.revoke(); service.revoke(); },
    async dispatch(value: unknown, authority: ResourceAuthority): Promise<string | null> {
      authority.assertActive();
      if (!owner.registration.domains.includes('resource')) return null;
      try {
        const type = value && typeof value === 'object' && 'type' in value ? value.type : null;
        if (type === 'resource.__chunk') return JSON.stringify(transfers.read(value));
        const request = parseResourceRequest(value);
        if (request.type === 'resource.cancel') transfers.cancel(request.id);
        const result = await service.execute(request, authority);
        authority.assertActive();
        if (result === null) return null;
        if (request.type === 'resource.bytes') {
          return JSON.stringify({ type: result.type, id: request.id, transfer: transfers.stage(request.id, result.value as ResourceBytes) });
        }
        if (request.type === 'resource.bytesMany') {
          const items = (result.items as ReadonlyArray<{ url: string; ok: boolean; value?: ResourceBytes; error?: string }>).map(item =>
            item.ok ? { url: item.url, ok: true, transfer: transfers.stage(request.id, item.value!) } : item);
          return JSON.stringify({ type: result.type, id: request.id, items });
        }
        return JSON.stringify(result);
      } catch (error) {
        if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') transfers.cancel(value.id);
        authority.assertActive();
        const failure = resourceFailure(value, error instanceof ResourceError ? error.code : 'network-error');
        return failure === null ? null : JSON.stringify(failure);
      }
    },
  });
}
