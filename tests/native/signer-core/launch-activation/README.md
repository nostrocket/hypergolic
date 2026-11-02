# Native vault launch admission regression

Run `python3 tests/native/signer-core/launch-activation/run.py --output /private/tmp/<fresh-directory>` on the owning Mac toolchain. The default reads canonical sources; source overrides support before/after review without editing the checkout.

The test compiles the actual launch gate from NativeVaultSession and the mutation gate, the actual failure enum, and the exact `refresh`, `activeEpoch`, `current`, `idle` and `open` methods extracted from NativeVaultSession. It exercises notification timing, duplicate opens, cancellation, native epoch/owner revocation, background/protected-data denial and absolute timeout boundaries before a counted dispatch. UIKit state, Expo ownership and core/storage dispatch are explicit host doubles. This does not establish physical protected storage, bridge/UI readiness or account acceptance; those need the ordinary app test.
