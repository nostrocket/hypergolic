# Android remote-operation final guard

```sh
python3 tests/native/signer-core/remote-operation/run.py --output /tmp/signer-remote-operation
```

The runner compiles the complete, unchanged production `NativeRemoteOperation.java`
with the pinned local JDK. Explicit host ports supply Android's monotonic clock,
`NativeVault.Error` and the relay `Control` interface. Independent `Guard.check`
and `Guard.execute` callbacks deterministically accept the first check and refuse
the final execution gate. The final gate must still run; after a possible signing
send, its refusal reports uncertainty instead of implying nothing was sent.

Fourteen cases cover final denial before/after signing admission, arbitrary runtime
refusal, check short-circuiting, exact deadline, cancellation and socket closure,
late socket attachment, non-signing frames, a rejected signing marker, and refusal
of the first signing-send callback. A write-admission counter increments only after
the production `beforeSend` callback returns. The socket port is an unconnected
`Socket` subclass that counts closes. Neither performs network I/O.

Fresh output is required. All input/tool hashes, compiler/test commands, output and
exit status are retained. Compilation failures, zero/missing cases and assertion
failures fail the receipt. To reproduce against exact retained pre-fix bytes, add
`--source /path/to/NativeRemoteOperation.before.java`; the runner copies those
bytes without rewriting their behavior. No source mutation occurs during a run.

This is host operation/error-classification evidence. It does not prove Android
lifecycle callbacks, native consent, protected storage, crypto, relay delivery,
signature production, publication, ordinary-app integration or phase acceptance.
The central native suite and its counts are unchanged. The first-send callback
and peer refusal/invalid-response classification are outside this product change.

## Confirmed external-result authority loss

```sh
python3 tests/native/signer-core/remote-operation/run-boundaries.py --output /tmp/signer-result-boundaries
```

This companion compiles the complete production operation and extracts, without
rewriting, the actual `NativeNip46Client.acceptedResult` method, the module's
`completed` callback and `NativeSigningSourceFacade.Capture.perform` method.
The Java/Kotlin host adapters explicitly supply authorization, synchronous
continuation, session, revision, completion-record and source-liveness ports.
Pinned cached Kotlin 2.1.20 compiler dependencies are used without Gradle or
resolution. Neither full native module nor NIP-46 protocol is reimplemented here.

The 13 accepted-result cases preserve correlated Resume ordering and the final
execute gate, map only post-send authority denial/expiry, preserve certain and
peer/storage errors, and retain interruption semantics. The 29 completion cases
exercise both external methods, successful recording/Resume, coded denial/expiry,
both actual pre-/post-effect `require` failures, unavailable liveness, unrelated
active-source exceptions, local counterparts, actionable storage/peer errors,
null explicit refusal and an inactive continuation. A confirmed external signed
result with lost native authority is uncertain; it is never resumed as success.

For retained-source red reproduction, `--client-source` and `--module-source`
select exact before bytes. Extracted-body and all source/compiler hashes, generated
host adapters, compiler/test outputs and nonpassing receipts are retained. These
are body-extraction/host-port regressions: they do not prove Android/Expo lifecycle
or coroutine scheduling, consent, real native storage, crypto, peer execution,
network sends or ordinary-app integration. Existing deadlines, first-send refusal
and peer validation remain unchanged. Root separately runs native compilation.

## Handoff authority versus correlation

The same `run-boundaries.py` command also compiles the complete production
`NativeHandoffTicket` and extracts the actual controller `captured`, `state`,
`execute` and `awaitResume` bodies without rewriting them. Controller/source,
foreground/unlocked and clock inputs are explicit host ports. The UI port queues
one Resume callback; a bounded worker test verifies the ticket remains pending
until the host explicitly pumps that callback. It then uses the real ticket's
verification/background/foreground/resume transitions. No browser, Activity or
native UI is involved.

Fourteen handoff cases distinguish cancellation, exact-deadline expiry and current
replacement from live wrong-ID or duplicate-result failures. Clock-read hooks
also revoke authority after the first pending observation and before verification.
Replacement current/ticket state and unconsumed result remain untouched. Live
Resume, resumed execution/foreground/source gates and ticket-null behavior remain
covered. `--controller-source` selects exact retained pre-fix bytes for red
reproduction. Existing accepted-result controls separately verify that only
post-send denial/expiry becomes uncertainty; invalid correlation is not remapped.
These remain host/body-extraction regressions, not full controller integration or
Android lifecycle acceptance. No native deadline or handoff permission changes.
