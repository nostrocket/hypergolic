# Signing approval

Every v1 event requires its own explicit trusted review. Silent-signing policies
and Approve all are outside this profile. The review, native signer and relay
publisher bind the same immutable event, source, account and destinations. Full
Phase 2/3 signing/publication acceptance remains open; see [testing](testing.md).

## Exact event and native authority

The native transport captures original request/registration after source, frame,
generation and sequence checks. Private authority handles remain native; shared
code claims a random token once and compares account, publisher, app, version,
instance and generation. UI uses separate process-unique presentation IDs.

Unsigned templates accept exactly kind, content, tags and created_at. Freeze a
deep copy with selected public key, finalized timestamp and normalized native
destinations. Validate integers, kinds, Unicode, tag structure and canonical
bytes under the [capability contract](capability-contract.md). Review identifies
requesting app/publisher/account, action, content and destinations; exact details
remain inspectable. Approve once consumes only this event.

Native source correlation and vault ID/revision reach the selected local,
NIP-46 or Android NIP-55 method. Native review is independently required; a shared
approval flag is insufficient. Check liveness/account around secret reads,
signing and awaits. Reparse/hash/verify returned signatures and every frozen field
without cached verification flags. No secret reaches a guest. See
[signing core](signing-core.md) and [external signing](external-signing.md).

## Queue and lifetime

| Native approval bound | Value |
| --- | --- |
| Registered sessions | 64 |
| Pending requests | Four/session, sixteen/global |
| Request lifetime | At most 600 monotonic seconds |
| Approved operations | One globally |
| Signing-publication SDK/client deadline | 660 seconds |

Review is FIFO within focused eligibility; unfocused requests wait and appear in
overview. Reject advances individual review. Dismiss rejects the current request
and pauses the queue globally until explicit Resume; changing focus cannot resume
it. Paused Resume occupies normal footer flow and reserves space below guest
content, with a minimum 52-point target. It appears only for a paused focused queue
outside signing/upload/blocked presentation; it must not overlay guest controls.

Focus loss revokes approved work. Background/inactive hides and pauses review,
retains unapproved requests and revokes approved in-flight authority. Returning
active still requires Resume. Bounded intentional native handoffs and OS
authentication have their own exact tickets/attempts; transient authentication
inactivity cannot create a new grant. Close, account/method changes, accepted
replacement, navigation/renderer loss, expiry and process death revoke authority.
Approvals are never persisted/replayed after restart.

Ordinary capability leases remain 25 seconds, with 27-second native-client and
30-second SDK deadlines. Only signing-publication uses the longer response
deadline. The whole-operation Kehto override avoids upstream stale-timestamp
resigning/rejection after review. Never refresh created_at or invent a caller
cancel wire operation. Old view callbacks/handles cannot deactivate a new session.

## Publication and outcomes

Guard the actual socket send, not merely observable subscription. Emit at most
one exact EVENT per selected destination; never silently retry, resign or emit
AUTH. Only a matching explicit relay OK means accepted/rejected. Connected,
queued or written bytes do not prove acceptance. Success requires at least one
explicit acceptance; preserve the richer per-relay native outcomes.

Failure before send is distinct from missing receipt after possible send. The
latter remains unknown; revocation cannot recall bytes. Source/vault liveness is
rechecked before effects and final delivery. Lost authority after possible
external signing/result is uncertain, not proof nothing was signed. Cleanup
revokes before releasing effect resources and targets only captured operations.

NIP-42 AUTH requires separate exact relay/challenge/socket/account authorization;
ordinary kind 22242 publication is denied. Ordinary signing also denies upload
authorization kinds; the dedicated upload lane retains exact-body/destination
authority. [Outbox](outbox-routing.md) freezes its selected routing plan under
the same per-event approval rather than silently extending destinations.

## Protocol and dependency evidence

The owning unsigned NAP-RELAY draft is
[`0be8abc`](https://github.com/napplet/naps/blob/0be8abce18beb46ca37bd4ddd042f58d30b4eedc/naps/NAP-RELAY.md).
NIP-01 is pinned to `01e707bacdc87cf262db80545aecaa8f17ac2a4f`; NIP-42 remains
separate. Integration pins Applesauce relay/core 6.2.1/6.2.0 and RxJS 7.8.2.
Relay source `faf30d2b5fd785acaf5b72c3095867348528583f` queues until connection
readiness; its higher-level retrying publication helper is not used. Keep the
lockfile's compatible nested dependencies rather than imposing an unreviewed
global override.

## Fixtures and checks

```sh
pnpm run typecheck
pnpm run test:security
pnpm run test:relay
python3 tests/native/android-approval-authority/runner.py --output /tmp/android-approval-proof
python3 tests/native/approval-unit/runner.py --build-root /tmp/ios-approval-proof
```

Use fresh outputs and installed platform tools. Approval Lab exercises genuine
SDK publication, note/profile and relay-list events; review each independently.
Its bundled bytes and hashes are verified, not a publisher-trust exception.
Controlled wire tests inspect actual frames, signatures and receipts without
relaxing production destination policy. Native authority/transport tests and
public-identity Simulator reviews have narrower scope than protected signing.
Test dismissal/resume, native inactivity, delayed sends, near expiry, queue races,
stale source/epoch, field mutation and post-send uncertainty on both platforms.
Current layout changes also need native input/geometry proof. [Testing](testing.md)
tracks acceptance separately from source/build/fixture evidence.
