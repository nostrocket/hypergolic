# Native iOS file-policy probe

This standalone XCTest probe compiles the application's exact `Contracts.swift` and `ExcludedAtomicFiles.swift` directly from their owning source paths. It exercises the real `SystemFilePolicy`, including Foundation attributes and backup exclusion. It does not link `IdentityFileStore`, `SystemKeychain`, Expo, React Native, or the Hypergolic application target.

Each test exclusively creates a UUID-named directory below its own test host's temporary directory, then uses the fixed child name `IdentitySecrets-v1`. Only literal nonsecret fixture bytes enter those files. The probe cannot select an application storage path, Keychain service, identity, or account. Cleanup checks the owned temporary path and reports cleanup failures. System entropy is used only for temporary file names; no Nostr or wrapping key is generated.

The evidence categories are deliberately separate:

| Target | Expected suite | Meaning |
| --- | --- | --- |
| iOS Simulator | 1 test: unsupported protection and zero sealed/pending payloads | The production guard rejects unavailable protection metadata. This is not a successful identity store or physical-device security proof. |
| Physical iOS | 3 tests: protected atomic replacement/read; file downgrade rejection; directory downgrade rejection before write | Real Foundation file-policy behavior on that device while unlocked. This does not prove locked-device behavior, backup transport exclusion, Keychain, authentication, or identity-vault integration. |

Both branches compile with an iOS 18.4 minimum, Swift 6, complete concurrency checking, and Swift warnings as errors. Xcode may emit its standard test-framework strip and absent-AppIntents metadata messages. Simulator compilation and unsigned iPhoneOS compilation require no Apple account or device. A signed physical build needs an existing local signing team, profile, and configured device; this runner does not enroll an account, alter provisioning settings, pass `-allowProvisioningUpdates`, or purchase services.

## Build without device execution

Run from this package with full Xcode selected. Build output must be fresh and outside source, or inside the source repository's ignored `.tools` directory.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
python3 -B -m unittest -v test_runner.py
python3 -B runner.py build --source-root /path/to/hypergolic --output /path/to/artifacts/file-policy-simulator --platform simulator
python3 -B runner.py build --source-root /path/to/hypergolic --output /path/to/artifacts/file-policy-iphoneos-compile --platform device
```

The unsigned iPhoneOS build checks the physical test branch but is not executable on a device. The build receipt records exact source, harness, generated project, full app-bundle files/symlinks, and the generated `.xctestrun` hash. Any source change fails the manifest check; review it and explicitly update `source-manifest.json` before creating a new build. Production code is neither copied nor patched by the runner. There are no external package dependencies or committed source symlinks.

## Explicit execution after authorization

`run` installs and executes only `org.nostrocket.hypergolic.filepolicyprobe` and its `FilePolicyTests` bundle on the explicitly supplied destination. It does not launch, replace, uninstall, or reset Hypergolic or any existing Simulator. Use a separate new output directory for each run.

```sh
python3 -B runner.py run --build /path/to/artifacts/file-policy-simulator --output /path/to/artifacts/file-policy-simulator-run --udid SIMULATOR_UUID
```

For a physical iPhone already configured for local signing:

```sh
python3 -B runner.py build --source-root /path/to/hypergolic --output /path/to/artifacts/file-policy-iphone --platform device --team YOUR_TEAM_ID
python3 -B runner.py run --build /path/to/artifacts/file-policy-iphone --output /path/to/artifacts/file-policy-iphone-run --udid DEVICE_IDENTIFIER
```

Keep the physical device unlocked and the probe foreground during these file-policy checks. The runner validates the exact generated host, test bundle, and dependency set before execution. It rejects changed source/products, unsigned physical builds, filtered suites, skipped tests, and unexpected test counts. Results remain in `Tests.xcresult`, `test-summary.json`, and `run.json`; a successful Simulator report is explicitly labeled `simulator-unsupported`.

The owning probe has passed its one Simulator test with zero skips, confirming unsupported protection and no secret payload creation. Both SDK branches compile. The portable source is byte-identical to that exercised probe; physical-device execution and identity-vault integration remain separate acceptance work.


The refreshed cache-clearing policy has passed a new Simulator run (one unsupported-
protection test, no skips), and its unsigned iPhoneOS branch compiles. The reviewed
source manifest names the exact current policy. This remains environment/compilation
evidence; no physical authentication or locked-device result is implied.
