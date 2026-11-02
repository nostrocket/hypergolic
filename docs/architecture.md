# Architecture

Hypergolic combines an Expo/React Native shell, local Android and iOS modules, and
a bundled Kehto web runtime. Applesauce provides selected Nostr integration.
The shell owns identities, permissions, trusted review and native operations;
napplets run as untrusted web content.

## Execution and authority

`index.ts` registers `src/App.tsx`. The shell opens bundled development fixtures or
verified published napplets. Published entry resolves a Nostr address, verifies
the signed manifest and content, requests access consent and pins the accepted
version. Updates require a separate review. Verification establishes artifact
integrity and publisher identity; it does not grant native authority.

Android WebView and iOS WKWebView host the packaged runtime. Native code stages
verified artifact bytes through a one-use registry. The runtime mediates guest
messages through the selected capability profile. There is no general-purpose
guest-to-native bridge or browser-signer fallback. Unsupported requested domains
are disclosed during review and confer no authority.

Native leases and shared brokers bind operations to their source, account,
generation, request and lifetime. Account changes, teardown and relevant lifecycle
events revoke authority. Async completion must recheck that binding before
delivering a result or performing a subsequent effect.

## Accounts and signing

An account is identified by its Nostr public key. Its selected signing method is
explicit: local native key, NIP-46 remote signer, or Android NIP-55 signer app.
There is no automatic fallback. Method changes preserve account-scoped napplet
data while revoking old signing authority and restarting sessions.

Native owners keep local keys and signer connection secrets out of guest and
React state. Signing binds trusted review to an immutable event, selected account
and vault revision. Returned events are checked against the approved fields,
canonical ID and signature before publication. Signing and relay acknowledgement
are separate outcomes; cancellation and uncertain completion must stay distinct.

Manual local-key reveal and deletion require OS authentication. A method removal
and whole-account deletion have different effects. Existing pre-release records
and migration behavior are described in the identity and signing contracts.
Hypergolic currently acts as an outgoing signer client; it does not expose an
incoming signer service to other applications.

## Persistence and network

SQLite stores ordinary application data, access grants, configuration and
workspace state with their documented scopes. It is not an encrypted user-data
vault. Workspace state includes opening order, selected napplet and an explicitly
empty workspace. Switching normally retains live state; unsaved drafts are not
guaranteed to survive process termination.

Published loading, relay operations, resources and uploads use native transport
owners with selected HTTPS/WSS destination, size and lifetime policies. Lookup,
publication and external-signer relays have distinct roles. Explicit consent and
native ownership remain required where specified; a network response cannot
authorize a new action by itself.

## Source layout

| Location | Responsibility |
| --- | --- |
| `src/` | Shell UI, shared brokers, services and contracts |
| `modules/` | Native identity, signing, host and capability owners |
| `runtime/` | Bundled Kehto host and browser-runtime tests |
| `napplets/` | Development labs and their independent build/test inputs |
| `plugins/` | Durable Expo native-generation changes |
| `scripts/` | Runtime build, tester packaging and verification tooling |
| `tests/` | Shared contracts, native harnesses and controlled fixtures |

Expo generates the ignored `android/` and `ios/` trees. Change native generation
through tracked app configuration, plugins and modules. The Android Release
configuration produces unsigned output; local tester signing is a separate step.
Hosted Expo updates are disabled.

## Selected contracts

| Area | Reference |
| --- | --- |
| Runtime and capability authority | [Native contract](native-contract.md), [capability contract](capability-contract.md), [admission](nap-support.md) |
| Identity and signing | [Identity storage](identity-storage.md), [account transitions](identity-switching.md), [signing core](signing-core.md), [external methods](external-signing.md), [approval](signing-approval.md) |
| Workspace | [Storage](workspace-storage.md), [optional close check](close-check.md) |
| Published artifacts | [Network boundary](published-network.md), [native registry](published-artifact-registry.md) |
| Relay operations | [Relay settings](relays.md), [query](relay-query.md), [subscriptions](relay-subscriptions.md), [Outbox](outbox-routing.md) |
| Other capabilities | [Resources](resource-access.md), [uploads](upload-access.md), [identity data](public-identity-data.md), [links](external-links.md), [intent/INC](intent-inc.md), [notifications/configuration](notifications-configuration.md) |
| Build dependencies | [Patches](dependency-patches.md), [notices and provenance](native-dependency-notices.md) |

## Current limits

The MVP capability scope extends through Outbox. Value transfers and zaps are
post-MVP work. Selected source integrations and focused tests do not close full
ordinary-app Android/iOS acceptance, protected-device checks, interoperability,
dependency review or final quality gates. A successful compile, browser fixture
or static score proves only its own scope. See the [development guide](development.md)
and co-located harness READMEs for checks and prerequisites.
