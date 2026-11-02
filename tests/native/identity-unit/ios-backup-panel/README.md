# iOS native backup panel Simulator proof

This source-linked XCTest host exercises the production `NativeBackupPanel.swift` and `NostrSecretBech32.swift` bytes directly. It uses the explicit public secp256k1 scalar `2`; it never opens the production identity store or weakens Simulator availability.

The three tests cover pre-presentation secret absence, native reveal and accessibility exclusion, an AX XXXL scroll-reachable Done button, promise completion after dismissal, cancellation during animated presentation, and synchronous resign-active clearing. The harness uses a native authentication double only to enter the actual production presenter. It does not establish protected storage, LocalAuthentication, production availability, screen-recording detection, screenshot prevention, or physical-device behavior.

Run against an explicit Simulator UDID and a fresh output directory:

```sh
# Select full Xcode as described in docs/development.md.
python3 tests/native/identity-unit/ios-backup-panel/runner.py \
  --udid SIMULATOR_UDID \
  --output /private/tmp/hypergolic-ios-backup-panel-run
```

The runner rejects changed production bytes, builds the source-linked app and XCTest bundle, executes exactly three tests, and writes `receipt.json`, `build.log`, `test.log`, `test-summary.json`, and `Tests.xcresult` under the output directory.
