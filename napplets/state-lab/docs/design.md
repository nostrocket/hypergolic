# State Lab design

The fixture lets an automated native driver exercise saved strings and public
identity through the real napplet SDK. Build two unsigned single-file artifacts:
`state-lab` and `state-lab-peer`. The peer uses the same controls with a different
stable app identity. Native host fixtures must also register a second publisher
namespace to test publisher isolation; a napplet cannot choose that namespace.

Required domains: `identity`, `storage`. Optional `theme` paints the whole surface
and falls back to the existing warm dark palette. Use SDK `identity.getPublicKey`,
`identity.onChanged`, `storage.getItem/setItem/removeItem/keys` and their instance
variants. Subscribe to identity changes before reading the initial identity; stale
identity or storage responses cannot repaint a newer selection. Signing, network,
config, resource, INC, intents and archetype metadata are absent.

One fluid column from 240 to 768 pixels. Show the full public key, a shared/instance
selector, key and literal string inputs, Read / Write / Remove / List keys controls,
a result with distinct missing, present and failed states, and a request counter.
Retain input on errors. Disable writes without a selected identity and disable
controls during an operation. An empty saved string must be distinguishable from
an absent key. Do not interpret stored HTML or JSON. Missing host requirements
show an unavailable state; the shell owns manifest compatibility admission.

No browser persistence, custom handshake, namespace identifiers, raw signing key
or privileged automation backdoor enters the artifact. Close identity/theme
subscriptions on pagehide. The host owns generation and identity-switch revocation.

Acceptance: unsigned metadata and exact hashes; real SDK calls for every storage
operation/scope; literal strings and empty-vs-missing; failed writes and reads;
identity and theme response races; signed-out state; narrow/light/dark layouts.
Browser fixture adapters prove UI behavior only. Genuine Kehto and both native
hosts must separately prove source admission, durable restart, user/publisher/app/
version/instance isolation, quotas, duplicate IDs, cancellation and late replies.

Owning specs are pinned in [the selected contract](../../../docs/capability-contract.md).
Workflow is adapted from RocketShell's design/build/test napplet skills at
`0b46d9cf8369576f11d87b92aa5436920fdfcd87`. This fixture uses no event API; the
project's selected relay profile and deferred outbox routing remain unchanged.
