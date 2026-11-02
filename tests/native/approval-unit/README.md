# Native approval authority unit tests

This isolated Swift package compiles the owning `modules/napplet-host/ios/NativeApprovalAuthority.swift` file directly. It does not copy the production policy into the test harness.

The core is intentionally unconnected: it exposes no Expo method, signer, relay, WebKit transport, review UI, or publication path. The native host may admit an immutable serialized snapshot only after its existing source, frame, generation, and sequence checks. Later integration must still validate the event snapshot and recheck approval before signing, verification, and every network effect.

The nine tests cover focused and foreground review, global pause and explicit resume, pending preservation, approved revocation, exact cancellation, one approved operation globally, take-once plus live checks through finish, request limits, UTF-8 bounds, admission-time expiry, backwards-clock failure, teardown, generation reuse, cross-authority handles, and stale view deactivation.

Run with a fresh disposable directory:

```sh
# Select full Xcode as described in docs/development.md.
python3 tests/native/approval-unit/runner.py \
  --build-root /private/tmp/hypergolic-approval-unit
```

The runner verifies the reviewed production, test, runner, package, and README hashes before and after execution and preserves `receipt.json` and `test.log` in the build root.
