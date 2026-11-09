# Native capability lease proofs

These standalone, host-executed programs exercise the production Java and Swift
registry implementations, with an injected monotonic clock. Each reports 107
assertions: exact expiry, admission limits, sequence consumption/replay/gaps,
UTF-8 bounds, one-use claim, generation revocation and concurrent claim ownership.
They do not instantiate a WebView or exercise Expo modules.

On macOS with the configured JDK and Xcode toolchains, from the repository root:

```sh
proof_directory=$(mktemp -d)
javac -d "$proof_directory" modules/napplet-host/android/src/main/java/org/nostrocket/hypergolic/host/CapabilityLeaseRegistry.java tests/native/capability-lease/CapabilityLeaseProof.java
java -cp "$proof_directory" CapabilityLeaseProof
xcrun swiftc -swift-version 6 -warnings-as-errors -parse-as-library modules/napplet-host/ios/CapabilityLeaseRegistry.swift tests/native/capability-lease/CapabilityLeaseProof.swift -o "$proof_directory/swift-proof"
"$proof_directory/swift-proof"
```

See [native admission evidence](../../../docs/native-capabilities.md) for the real
SQLite broker tests and separately executed WKWebView checks.

## Native deferred-read selectors

With JDK 17 on `PATH`, Xcode selected, and the existing `.tools/gradle-home`
dependency cache populated, run:

```sh
python3 -B tests/native/capability-lease/defer_selector.py
```

This uses the same cached Kotlin 2.1.20 and JSON artifacts as the published
capability parser proof. It extracts the actual Android and iOS view selector
methods unchanged and compiles them with the production configuration parsers.
Each platform checks 32 read/grant, publication/subscription/control and invalid-ID
cases. These are host compiler checks; they do not instantiate a WebView or
exercise an Expo bridge or device.
