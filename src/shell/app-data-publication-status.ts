import type {RelayOutcome} from '../network/relay-service.ts';

/** The app-data convention requires acceptance from every selected relay. */
export function appDataPublicationStatus(results: readonly RelayOutcome[]): string {
  const accepted = results.filter(row => row.status === 'accepted').length;
  const unknown = results.filter(row => row.status === 'unknown').length;
  if (results.length === 0) return 'Publication could not be confirmed.';
  if (accepted === results.length) {
    return results.length === 1 ? 'The required relay accepted the public record.'
      : `All ${results.length} required relays accepted the public record.`;
  }
  const delivery = `${accepted} of ${results.length} required ${results.length === 1 ? 'relay' : 'relays'} accepted the public record.`;
  return unknown
    ? `${delivery} Delivery to ${unknown} ${unknown === 1 ? 'relay' : 'relays'} is unconfirmed.`
    : `${delivery} The update is incomplete.`;
}
