# iOS NIP-46 relay expiry

These focused macOS host checks compile bodies extracted from the owning iOS
transport. Run from the repository root with the local Xcode toolchain:

```sh
python3 tests/native/signer-core/relay-expiry/run.py --output /tmp/relay-expiry
python3 tests/native/signer-core/relay-expiry/run-pong.py --output /tmp/relay-pong
```

Each output directory must be new. To test a staged source, add
`--source /path/to/NativeSignerRelayTransport.swift`. The default source is
`modules/napplet-host/ios/NativeSignerRelayTransport.swift` relative to the current
repository root. No package installation is required.

`run.py` checks 14 assertions against the actual `Budget` and `Operation.live`
bodies with explicit host operation state. Plain expiry must remain a lifetime
failure before dispatch and uncertainty after dispatch. Poisoned, mismatched,
exhausted and invalid-charge budgets remain invalid responses even with expiry.

`run-pong.py` checks 5 assertions against the actual pong branch and masking
method. Host ports inject RNG failure, expiry and invalid-budget errors. Only
expiry may propagate; RNG failure must remain invalid and cannot become a
retryable unavailable result after a possible RPC send.

Both runners retain the generated Swift harness, compile log, original test
stdout/stderr and JSON receipt. They fail on compilation/test errors, missing or
incomplete assertions, and source/runner changes during verification. They do not
exercise Network.framework, TLS, UIKit, a relay, a device or app lifecycle and do
not close ordinary-app or physical acceptance.
