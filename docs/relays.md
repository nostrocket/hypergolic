# Default relays

The first-run relay configuration is defined in
[`src/config/default-relays.json`](../src/config/default-relays.json).

| Role | Relay URLs, in order |
| --- | --- |
| Network reads and approved writes | `wss://relay.ditto.pub`, `wss://nos.lol`, `wss://relay.damus.io` |
| Lookup and manifest discovery | `wss://purplepag.es`, `wss://relay.damus.io`, `wss://nos.lol` |

## Source evidence

RocketShell's [constants and first-run settings](https://github.com/nostrocket/rocketshell/blob/0b46d9cf8369576f11d87b92aa5436920fdfcd87/apps/shell/src/platform.ts#L24-L35)
map its network array to `backupRelays` and discovery array to `lookupRelays`.
Its [platform initialization](https://github.com/nostrocket/rocketshell/blob/0b46d9cf8369576f11d87b92aa5436920fdfcd87/apps/shell/src/platform.ts#L93-L104)
then uses those lists for discovery and the read/write tiers. These are production
seed settings, not URLs taken from tests or example napplets.

Hypergolic started with RocketShell’s defaults. On 9 November 2026, Bucket’s relay information advertised 30-second retention. Ditto advertised no authentication or payment requirement, and a signed test event was accepted and independently retrieved there. Ditto now replaces Bucket in new Network lists. Existing settings retain their members and order. [Bucket relay information](https://bucket.coracle.social) · [Ditto relay information](https://relay.ditto.pub)

RocketShell also gives published account lists precedence; Hypergolic now implements the selected NIP-65 discovery/routing profile described
in [Outbox routing](outbox-routing.md), whose complete physical acceptance remains
open. Its role rules govern how account lists and explicit local settings interact. A lookup relay used to retrieve an explicitly requested
napplet manifest does not itself enable automatic account relay-list discovery.

## Persistence and failure

The native settings service seeds the JSON values on first open in a dedicated
SQLite database, then preserves edits and explicit empty lists across restarts.
Trusted settings provide separate Network and Lookup controls to add or remove
secure WebSocket URLs and restore either role's defaults. In Network, **Move up** and **Move down** change the saved order while retaining every relay. Basic live reads without a specified relay use the first two entries. Approved Relay publication can use the entire Network list. Outbox uses its separate routing rules. If native validation rejects the first four Network relays for remote services, the shell retains the saved order and clears automatic CVM defaults. A later valid order restores those defaults. Explicit CVM relay selections use their existing validation. A storage failure keeps
identity entry available, makes relay settings visibly unavailable and rejects
new publication requests before signing. The signing approval path snapshots the
current Network list when a request is admitted; it no longer holds the startup
defaults for the process lifetime.

Lookup selections feed Settings opens, saved-revision reopens and update checks.
[Reviewed opens from Discover](published-open.md) query the union of the selected
Lookup and Network relays so a publication visible on a Network relay can be
resolved there. [Bounded historical queries](relay-query.md) snapshot the current Network list and
use native WSS. [Public identity data](public-identity-data.md) uses that query
service for profile reads. Setting an endpoint is not proof that a query, subscription or publication reached it. Availability, AUTH and write acceptance cannot be inferred from adopting
endpoint defaults. Every event update still requires explicit shell confirmation
before signing/publication.

The controlled test relay remains separate from these public defaults. [Fixture publisher](fixture-publisher.md) records the separate signing authority
and release relay/Blossom configuration and verification. RocketShell's separate Blossom fallback was observed
but is not selected by this relay-list request.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Use `pnpm run test:relay` and the [development guide](development.md) for native settings journeys. Compare exact ordered arrays, first-open seed, edits/removal, Network reorder, explicit empty lists, restart and explicit defaults restoration. Include invalid URLs/storage failures and disjoint Network/Lookup role routing.
