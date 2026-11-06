# Intent and inter-napplet communication

Verified named NIP-5D handlers use [NAP-INTENT at 43cb3a4](https://github.com/napplet/naps/blob/43cb3a4e855570ec4b90b9cc05f0c721e5ad0aab/naps/NAP-INTENT.md) with the existing Kehto window-message binding. Legacy handlers retain their [a040914 Intent](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INTENT.md) and [INC](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INC.md) behavior. The modern browser API is checked against the [SDK at efd5aa1](https://github.com/napplet/web/blob/efd5aa103359f1b150dfbb8870fa23e90fbc5540/packages/nap/src/intent/shim.ts).

## Handler selection and review

The app retains signed manifests of verified napplets opened with ordinary domain consent. The catalog and defaults are scoped to the selected identity, and retained after views close or the app restarts. Every read verifies the signed manifest again. Corrupt rows are removed together with their preferences. Only previously verified artifacts can enter the catalog; guest content cannot register itself or set defaults.

An explicit user default chooses its exact publisher and app. Unsupported action/convention fails without silently replacing it. Without a default, selection considers compatible role/action/convention candidates: the sole compatible handler is proposed, or the user chooses. Modern handlers advertise matching signed `z` roles and `i` conventions. A convention matches its role and action exactly. Trailing `i` fields advertise parameter names. Incomplete or conflicting advertisements add no route. Catalog IDs distinguish publishers. Legacy roles and conventions can differ, and a specific legacy dTag shared by publishers is rejected. A channel target shared by multiple live views is also rejected.

Every dispatch reviews the actual native-bound requester, handler/publisher and complete bounded JSON payload. A default or explicit dTag never waives this approval. The user may explicitly save a default through the chooser or Settings. Settings also clears preferences and removes registration. Removal leaves napplet data and verified artifact storage intact. Opening the napplet again restores registration.

Routing and Discover Open share a native review slot with Upload and signing. A focused requester receives `review busy` when that slot is occupied. Discover Open returns `busy`. A pending Upload or signing request can appear when the current review ends, subject to its existing lease. An in-flight signing presentation and its publication receipt keep the slot while focused and foregrounded.

A matching loaded handler is reused unless `newWindow: true` or `reuse: false` requests another view. Review states that another view will open. `focus: false` preserves the caller's focus. A closed handler follows the ordinary exact pinned manifest and admission path. A modern `focus: false` dispatch requires an already-ready instance of the exact pin. A cold target returns `handler requires focus` without opening a view.

Modern handlers receive `intent.deliver` under their approved Intent grant. The native-bound source supplies the publisher-scoped sender ID, and the runtime targets the exact approved, ready generation. Native acceptance reserves one of four routing slots on the target generation. With every slot held, dispatch returns `handler delivery unavailable`. A private frame-bound receipt releases each Intent slot only after the binding calls an `onDelivery` subscriber. The binding retains deliveries until registration and allows up to 32 subscriptions per frame. Accepted Intent payloads waiting for native forwarding stay parked across a foreground pause and resume only for the same authorized generation. Owner replacement or generation teardown ends delivery. Legacy handlers still require an approved INC grant and exact-topic subscription.

## Topics and channels

Each loaded view separately approves each exact topic. Emission targets only approved same-identity subscribers, with no sender echo. Foreground switching retains delivery. Background pauses topics and preserves the existing loaded session's approval, with no payload backlog. Close, update and identity transitions revoke the old generation and its topic authority.

Each new channel reviews its two actual native endpoints once. The target's inbound handle is enqueued before opener success. Messages and broadcasts thereafter need no new prompts. Channels close on background, endpoint destruction, identity change or bounded delivery overflow. New channels on return require fresh approval. Bounded terminal control records can survive background and arrive on return; payloads cannot. Endpoint destruction reports `peer destroyed`, as required by the pinned draft.

The pinned SDK retains an unclaimed channel handle/message/terminal record. Local `ChannelHandle.close()` immediately retains a record containing the channel id, without a reason; the other endpoint receives `closed`. The draft allows an absent reason. Native evidence checks these original SDK values rather than adding synthetic acknowledgements.

## Native authority and transport

The app owns cross-view routing; isolated per-view Kehto INC maps cannot provide it. Android and iOS hold the actual identity/epoch, generation, readiness, domain grants, foreground state and revision. Source registrations are compared in full against the captured native request. Guest fields cannot select sender, identity, generation, defaults or native recipient.

Native one-use leases expire after 25 seconds on the continuous native clock. Shared strict sequence counters reject replay. The native client has a 27-second transport deadline, and the pinned SDK's intent/channel promises have 30-second deadlines. Expired/revoked native authority cannot produce a late guest result or delivery. Focus is required for presenting a review; foreground delivery between loaded views does not require focus.

The locked Kehto runtime patch selects explicit whole-operation overrides after session/domain/ACL/firewall checks. It restores the built-in `relay:read` recipient requirement for canonical incoming INC events only when native INC overrides are selected. It does not add a generic postMessage bypass. Modern Intent pushes retain the existing `intent:read` recipient check. Native events are `inc.event`, `inc.channel.opened`, `inc.channel.event`, `inc.channel.closed`, `intent.changed` and `intent.deliver`. Catalog/default changes push availability only to live same-identity intent recipients; these bounded live pushes have no background backlog or delivery guarantee. Callers can query current availability after return.

## Engineering bounds and unsupported input

JSON capture rejects accessors, symbols, unexpected keys/prototypes, cycles, sparse arrays, nonfinite numbers, negative zero and unsupported values. Payload limits are 32KiB UTF-8, depth32 and 2048 nodes. Identifiers, roles, topics and conventions have explicit UTF-8/length limits. Modern `invoke(uri, options)` and `open(uri, options)` transpose unique decoded query pairs into text fields. Literal plus stays plus. Fragments and handler recommendations are outside this profile. Duplicate keys, malformed escapes and mixing query sugar with an explicit payload are rejected. Legacy object invocation and its query-bearing wire convention remain supported.

Catalog bounds are 64 apps per identity, 256 total and 4MiB signed events. Routing admits 64 endpoints, 16 topics and 8 channels per endpoint, with terminal records included in the channel quota. Review queues are bounded to eight globally/four per generation. Native pending requests are bounded to eight globally/four per generation, and incoming routing pushes to four per generation. Intent consumption receipts are private to the binding and carry no application delivery ID. Fire-and-forget operations have no invented wire id or delivery receipt. A handler needs its approved recipient domain and a live, ready endpoint. Legacy INC dispatch also needs the approved topic.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:routing` and `pnpm run test:routing:native`; the former uses a labelled native-port double and the latter compiles production Java/Swift endpoint cores. Use [native routing journeys](../tests/native/routing/README.md) for ordinary hosts. Cover exact-topic/handler consent, readiness/order, defaults and cold admission, publisher/account collision, expiry/replay, overflow, background, endpoint replacement and original SDK terminal records. Browser adapter tests do not establish native security.
