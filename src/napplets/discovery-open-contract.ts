export const DISCOVERY_OPEN = 'hypergolic.publishedOpen';
export const DISCOVERY_LEASE_MS = 120_000;
export const DISCOVERY_STATUSES = ['opened', 'busy', 'cancelled', 'rejected', 'not-found', 'unsupported',
  'conflict', 'refresh-required', 'failed', 'unavailable'] as const;
export type DiscoveryOpenStatus = typeof DISCOVERY_STATUSES[number];
export type DiscoveryOpenRequest = Readonly<{
  type: typeof DISCOVERY_OPEN; id: string; address: string; expectedEventId: string;
}>;

export function parseDiscoveryOpen(value: unknown): DiscoveryOpenRequest {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 4) throw new Error('Invalid published open request');
  const { type, id, address, expectedEventId } = value as Record<string, unknown>;
  if (type !== DISCOVERY_OPEN || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
      typeof address !== 'string' || !/^naddr1[023456789acdefghjklmnpqrstuvwxyz]{1,506}$/.test(address) ||
      typeof expectedEventId !== 'string' || !/^[0-9a-f]{64}$/.test(expectedEventId)) throw new Error('Invalid published open request');
  return Object.freeze({ type, id, address, expectedEventId });
}

export function discoveryOpenStatus(value: unknown): value is DiscoveryOpenStatus {
  return typeof value === 'string' && (DISCOVERY_STATUSES as readonly string[]).includes(value);
}
