# Default relays

The approved first-run relay configuration is
[`src/config/default-relays.json`](../src/config/default-relays.json), taken from
RocketShell's production defaults at revision `0b46d9cf8369576f11d87b92aa5436920fdfcd87`,
inspected on 14 September 2026. Preserve the two roles and order:

| Role | Relay URLs, in order |
| --- | --- |
| Network reads and approved writes | `wss://relay.damus.io`, `wss://nos.lol`, `wss://bucket.coracle.social` |
| Lookup and manifest discovery | `wss://purplepag.es`, `wss://relay.damus.io`, `wss://nos.lol` |

## Source evidence

RocketShell's [constants and first-run settings](https://github.com/nostrocket/rocketshell/blob/0b46d9cf8369576f11d87b92aa5436920fdfcd87/apps/shell/src/platform.ts#L24-L35)
map its network array to `backupRelays` and discovery array to `lookupRelays`.
Its [platform initialization](https://github.com/nostrocket/rocketshell/blob/0b46d9cf8369576f11d87b92aa5436920fdfcd87/apps/shell/src/platform.ts#L93-L104)
then uses those lists for discovery and the read/write tiers. These are production
seed settings, not URLs taken from tests or example napplets.

Hypergolic adopts the endpoint lists as editable local defaults. The implementation
must seed them only when no saved configuration exists, preserve explicit user edits,
and use the selected local lists for v1. RocketShell also gives published account
lists precedence; Hypergolic now implements the selected NIP-65 discovery/routing profile described
in [Outbox routing](outbox-routing.md), whose complete physical acceptance remains
open. Its role rules govern how account lists and explicit local settings interact. A lookup relay used to retrieve an explicitly requested
napplet manifest does not itself enable automatic account relay-list discovery.

## Persistence and failure

The native settings service seeds the JSON values on first open in a dedicated
SQLite database, then preserves edits and explicit empty lists across restarts.
Trusted settings provide separate Network and Lookup controls to add or remove
secure WebSocket URLs and restore either role's defaults. A storage failure keeps
identity entry available, makes relay settings visibly unavailable and rejects
new publication requests before signing. The signing approval path snapshots the
current Network list when a request is admitted; it no longer holds the startup
defaults for the process lifetime.

Lookup selections feed the connected published-napplet transport adapter.
[Bounded historical queries](relay-query.md) snapshot the current Network list and
use native WSS. [Public identity data](public-identity-data.md) uses that query
service for profile reads. Setting an endpoint is not proof that a query, subscription or publication reached it. Availability, AUTH and write acceptance cannot be inferred from adopting
endpoint defaults. Every event update still requires explicit shell confirmation
before signing/publication.

The controlled test relay remains separate from these public defaults. [Fixture publisher](fixture-publisher.md) records the separate signing authority
and release relay/Blossom configuration and verification. RocketShell's separate Blossom fallback was observed
but is not selected by this relay-list request.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Use `pnpm run test:relay` and the [development guide](development.md) for native settings journeys. Compare exact ordered arrays, first-open seed, edits/removal, explicit empty lists, restart and explicit defaults restoration. Include invalid URLs/storage failures and disjoint Network/Lookup role routing.
