# iOS action and authentication lifetime regression

This host regression compiles ten actual `NativeVaultSession` methods and the production `NativeVaultMutationGate`. Its 77 assertions retain the original 24 timer-ownership checks. The added cases cover the 60-second authentication boundary, cancellation and attempt ownership, late callbacks, backup read/reveal expiry, deletion permit expiry, and cleanup after a replacement request starts.

UIKit, authentication, keys, core reads and storage operations are explicit test doubles. A controlled monotonic clock advances while real Swift task timers remain queued. The harness exposes the actual post-sleep timer callback to control its delivery. The deletion double records the supplied validity check without enforcing it, so the production mutation gate independently rejects an expired write permit. These checks do not exercise OS authentication, protected storage or physical device behavior.

```sh
python3 tests/native/signer-core/action-timeout/run.py \
  --toolchain-root "${HYPERGOLIC_HOST_TOOLCHAIN:?Set an existing Swift toolchain root}" \
  --sdk "${HYPERGOLIC_HOST_SDK:?Set an existing macOS SDK}" \
  --output /tmp/signer-action-auth-lifetime-UNIQUE
```

Use a fresh output directory. The toolchain root must contain `usr/bin` and `usr/lib/swift`; the SDK must already exist. Compiler, resources, tools and linker paths derive from that root. `--target` optionally selects the host deployment target. The runner uses private cache/output directories and a restricted environment. It does not invoke `xcrun`, `xcodebuild`, `devicectl` or component setup.

`--session-source` selects old or new session source for a red/green comparison. The adapter accepts the original integer and corrected tuple return shapes without changing the extracted authority checks. Both versions compile: the old source fails 34 assertions and the corrected source passes all 77. Compiler and test processes have separate time limits. Receipts record source/test/gate hashes, commands, outputs and exit codes. `--driver-print-jobs` only prints planned compiler jobs; it does not run the regression.

Standalone host results remain separate from integrated iPhone compilation, native suite counts and Phase 3 acceptance.
