# Intent and inter-napplet communication

Hypergolic selects the draft [NAP-INTENT](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INTENT.md), [NAP-INC](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INC.md) and archetype metadata at the same revision. This is a pinned interoperability target, not a final standard. Value transfers remain Phase 4.

## Handler selection and review

The app retains signed manifests of verified napplets opened with ordinary domain consent. The catalog and defaults are scoped to the selected identity, and retained after views close or the app restarts. Every read verifies the signed manifest again. Corrupt rows are removed together with their preferences. Only previously verified artifacts can enter the catalog; guest content cannot register itself or set defaults.

An explicit user default chooses its exact publisher and app. Unsupported action/convention fails without silently replacing it. Without a default, selection considers compatible role/action/convention candidates: the sole compatible handler is proposed, or the user chooses. Roles and conventions are independent; a convention need not share its role's name. A specific dTag shared by publishers is rejected. A channel target shared by multiple live views is also rejected.

Every dispatch reviews the actual native-bound requester, handler/publisher and complete bounded JSON payload. A default or explicit dTag never waives this approval. The user may explicitly save a default through the chooser or Settings. Settings also clears preferences and removes registration. Removal leaves napplet data and verified artifact storage intact. Opening the napplet again restores registration.

A matching loaded handler is reused unless `newWindow: true` or `reuse: false` requests another view. Review states that another view will open. `focus: false` preserves the caller's focus. A closed handler follows the ordinary exact pinned manifest/admission path, and needs a fresh exact-topic session approval before receiving an intent. Success means native delivery was enqueued after readiness, not that the handler accepted or processed its payload.

## Topics and channels

Each loaded view separately approves each exact topic. Emission targets only approved same-identity subscribers, with no sender echo. Foreground switching retains delivery. Background pauses topics and preserves the existing loaded session's approval, with no payload backlog. Close, update and identity transitions revoke the old generation and its topic authority.

Each new channel reviews its two actual native endpoints once. The target's inbound handle is enqueued before opener success. Messages and broadcasts thereafter need no new prompts. Channels close on background, endpoint destruction, identity change or bounded delivery overflow. New channels on return require fresh approval. Bounded terminal control records can survive background and arrive on return; payloads cannot. Endpoint destruction reports `peer destroyed`, as required by the pinned draft.

The pinned SDK retains an unclaimed channel handle/message/terminal record. Local `ChannelHandle.close()` immediately retains a record containing the channel id, without a reason; the other endpoint receives `closed`. The draft allows an absent reason. Native evidence checks these original SDK values rather than adding synthetic acknowledgements.

## Native authority and transport

The app owns cross-view routing; isolated per-view Kehto INC maps cannot provide it. Android and iOS hold the actual identity/epoch, generation, readiness, domain grants, foreground state and revision. Source registrations are compared in full against the captured native request. Guest fields cannot select sender, identity, generation, defaults or native recipient.

Native one-use leases expire after 25 seconds on the continuous native clock. Shared strict sequence counters reject replay. The native client has a 27-second transport deadline, and the pinned SDK's intent/channel promises have 30-second deadlines. Expired/revoked native authority cannot produce a late guest result or delivery. Focus is required for presenting a review; foreground delivery between loaded views does not require focus.

The locked Kehto runtime patch selects explicit whole-operation overrides after session/domain/ACL/firewall checks. It restores the built-in `relay:read` recipient requirement for canonical incoming INC events only when native INC overrides are selected. It does not add a generic postMessage bypass. Native events are `inc.event`, `inc.channel.opened`, `inc.channel.event`, `inc.channel.closed` and `intent.changed`. Catalog/default changes push availability only to live same-identity intent recipients; these bounded live pushes have no background backlog or delivery guarantee. Callers can query current availability after return.

## Engineering bounds and unsupported input

JSON capture rejects accessors, symbols, unexpected keys/prototypes, cycles, sparse arrays, nonfinite numbers, negative zero and unsupported values. Payload limits are 32KiB UTF-8, depth32 and 2048 nodes. Identifiers, roles, topics and conventions have explicit UTF-8/length limits. Query convention sugar transposes unique decoded text pairs without coercion; literal plus stays plus. Fragments, duplicate keys, malformed escapes and mixing query sugar with an explicit payload are rejected.

Catalog bounds are 64 apps per identity, 256 total and 4MiB signed events. Routing admits 64 endpoints, 16 topics and 8 channels per endpoint, with terminal records included in the channel quota. Review queues are bounded to eight globally/four per generation. Native pending requests are bounded to eight globally/four per generation, and incoming routing pushes to four per generation. Overflow cannot create an unbounded queue. Fire-and-forget operations have no invented wire id or delivery receipt. A handler that lacks the approved INC domain/readiness/topic cannot receive a payload.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run `pnpm run test:routing` and `pnpm run test:routing:native`; the former uses a labelled native-port double and the latter compiles production Java/Swift endpoint cores. Use [native routing journeys](../tests/native/routing/README.md) for ordinary hosts. Cover exact-topic/handler consent, readiness/order, defaults and cold admission, publisher/account collision, expiry/replay, overflow, background, endpoint replacement and original SDK terminal records. Browser adapter tests do not establish native security.
