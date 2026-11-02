import type {RelayOutcome} from '../network/relay-service.ts';
const OUTCOME_STATUSES=new Set<RelayOutcome['status']>(['accepted','rejected','unknown','cancelled-before-send']);
function denied():never {throw new Error('APPROVAL_DENIED');}
export function captureRelayOutcomes(value: unknown, destinations: readonly string[], eventId: string): readonly RelayOutcome[] {
  if (!Array.isArray(value) || value.length !== destinations.length) denied();
  const rows: RelayOutcome[] = [];
  for (let index = 0; index < value.length; index++) {
    const indexed = Object.getOwnPropertyDescriptor(value, String(index));
    if (!indexed || !('value' in indexed)) denied();
    const row = indexed.value;
    if (row === null || typeof row !== 'object') denied();
    const relay = Object.getOwnPropertyDescriptor(row, 'relay');
    const id = Object.getOwnPropertyDescriptor(row, 'eventId');
    const status = Object.getOwnPropertyDescriptor(row, 'status');
    const reason = Object.getOwnPropertyDescriptor(row, 'reason');
    if (!relay || !id || !status || !reason || !('value' in relay) || !('value' in id) || !('value' in status) || !('value' in reason) ||
      relay.value !== destinations[index] || id.value !== eventId || typeof status.value !== 'string' || !OUTCOME_STATUSES.has(status.value as RelayOutcome['status']) ||
      typeof reason.value !== 'string' || reason.value.length > 4096) denied();
    rows.push(Object.freeze({ relay: relay.value, eventId: id.value, status: status.value as RelayOutcome['status'], reason: reason.value }));
  }
  return Object.freeze(rows);
}
