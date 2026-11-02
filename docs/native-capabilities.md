# Native capability admission

The process-owned identity/workspace owner, shared brokers and both native
transports connect the Kehto runtime to scoped native operations. Bundled fixtures
and verified published napplets share the reviewed domain profile, but acquire
authority only through their own registration and grants. See the
[capability contract](capability-contract.md) and [testing](testing.md).

## Runtime and shell integration

The runtime verifies artifact hashes and keeps genuine Kehto source-window,
session, ACL and firewall checks ahead of its host-only operation adapter. The
native client bounds pending requests, correlates original operations/IDs and
rejects late, foreign or malformed replies. Browser storage and signer fallbacks
are disabled.

One mounted component lifetime owns an immutable view binding. Snapshot cloning
or focus changes must not reset request history. The process owner captures
selected account/epoch, accepted inventory revision and exact live workspace
membership. Persisted native UUID instance IDs survive restart; closing and
opening a new instance obtains another ID. Read-only public identity must match
the selected shell account.

The supported domains are identity, storage, theme, relay, resource, upload, link,
intent, inc, notify, config and outbox. A domain's presence does not grant every
operation or claim full draft conformance. Dedicated owners retain publication,
link, routing and upload authorization. Outbox also requires the Relay grant.

## Ownership and request lifetime

Trusted configuration captures session, public account/epoch, publisher, stable
app, version, persisted instance, descriptor and domains. Each host adds a fresh
generation. Neither configuration nor view props accept arbitrary HTML or URLs;
published content uses the verified one-use [artifact registry](published-artifact-registry.md).

Native receipt checks the actual WebView, main frame, origin, exact document URL,
generation, readiness and transport schema. Original NAP JSON remains a string in
the native-held snapshot, preserving payload bytes until shared validation.
React Native receives a random one-use token, session ID and generation.
Synchronous claim/liveness methods cannot create or extend a lease from a delayed
event.

| Ordinary identity/storage transport | Bound |
| --- | --- |
| Active generations | 64 |
| Pending requests | Four/generation, eight/global |
| Native lease | 25 seconds |
| Serialized snapshot | 2 MiB UTF-8, including nested JSON escaping |
| Correlation history | 1,024 operation/ID pairs per broker |
| Storage | 1 KiB key, 256 KiB value, 512 KiB namespace including keys/values |

Android uses elapsed monotonic time; iOS uses `ContinuousClock`, including sleep.
Cleanup timers do not confer authority. Final consumption/generation checks occur
on the UI thread immediately before the original reply callback. Publication has
a separate longer [approval lifetime](signing-approval.md).

Exhausted correlation history requires a new session; forgetting IDs would permit
replay. A valid next transport sequence is consumed even under overload. Gaps or
old sequences cannot acquire a lease. Backgrounding invalidates pending ordinary
work while retaining loaded sessions and replay counters. Close, navigation
failure and teardown revoke the generation synchronously.

Database operations recheck ownership around awaits and before commit. Revoked
precommit writes roll back. Revocation after commit cannot undo the write, but
must prevent stale success delivery. Release the request binding afterward.
Failed workspace binding, changed descriptors and unaccepted inventory revisions
deny operations.

## Supported broker operations

The [wire contract](capability-contract.md#message-shapes) governs exact fields.
Identity is read-only; the [public identity owner](public-identity-data.md) supplies
supported signed public data and separately consented sensitive lists. Native
storage implements get/set/remove/keys in its composite namespace. Missing values
are null, empty strings remain empty, failures use canonical result/error shapes
and write success follows commit. Caller-selected account, publisher, app, version
or instance fields are denied.

Relay query and selected Outbox reads use the captured registration and their
bounded read services. Subscriptions, publication, uploads, resources, links,
routing and notification/configuration operations retain dedicated owner checks;
ordinary lease admission cannot substitute for their permissions or review.

## Verification

```sh
pnpm run test:capabilities
pnpm run test:storage
pnpm run test:query
pnpm run test:outbox
```

State Lab and its peer exercise genuine SDK missing/empty distinctions, literal
strings and identity/instance isolation. Android `tests/native/state_storage.py`
and the iOS `state-storage` scenario use isolated installed fixtures. Native
admission, WK boundary and lease harnesses retain their local instructions.
See [testing](testing.md) for cases and evidence limits. Full ordinary-app,
protected-device and Phase 2/3 acceptance remain open.
