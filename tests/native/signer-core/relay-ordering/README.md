# Native relay-response ordering regression

On macOS with Xcode selected:

```sh
python3 tests/native/signer-core/relay-ordering/run.py --output /tmp/signer-relay-ordering
```

The fresh output records all commands, source hashes, compiler output and the
actual test result. `--client-source` selects an explicit staged client for
pre-integration validation; the default compiles the repository's owning client.

The test runs actual native Client/Handoff/Protocol/Key and C NIP-01/NIP-44 code.
Its in-memory exchange authenticates/decrypts outgoing RPCs and supplies signed,
encrypted original-ID challenge/results. Changed signing relays must never
restore paused execution, including Resume requested before the final response.
Same-list signing, explicit refresh and handshake proposals remain positive controls.
Snapshots are captured before harness cancellation.

Transport/budget/URL support and pause callbacks are explicit test doubles.
No sockets, Simulator, UIKit, lower effect registry or physical acceptance is
exercised. Accidental default exchange fails. No production implementation is
copied into this directory.
