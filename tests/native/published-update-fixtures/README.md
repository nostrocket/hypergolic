# Published update native fixture

This test entry uses a randomly generated public identity whose disposable
secret was discarded. It serves two independent napplet coordinates, each with
two separately signed, embedded kind-35129 revisions. The update QA napplet
keeps its `theme` access in v2. The changed-access QA napplet adds `relay` to
`theme` in v2, requiring a separate access review after the event update review.
The signing keys were discarded; the app cannot sign or publish. Each newer
revision becomes discoverable only after its own release action. The native
drivers use the ordinary first-open consent, process-owned update coordinator,
Settings reviews, workspace replacement, and native host. No public relay or
Blossom server participates.

Build a separate Android Release package in an isolated test checkout or
generated Android tree. In the generated `android/app/build.gradle`, change only:

- `react.entryFile` to `file('../../tests/native/published-update-fixtures/index.tsx')`
- `defaultConfig.applicationId` to `org.nostrocket.hypergolic.publishedupdatefixture`

Save the original Gradle file outside the tree first, and restore its exact
bytes in a shell `trap` even if the build fails. Do not install this over the
normal app. With the pinned local tools loaded, build, align, sign with the
repository's disposable debug key, and verify the separate APK:

```sh
# Configure the pinned tools described in docs/development.md.
android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a --console=plain
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -f 4 \
  android/app/build/outputs/apk/release/app-release-unsigned.apk \
  /private/tmp/hypergolic-update-aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign \
  --ks android/app/debug.keystore --ks-pass pass:android \
  --key-pass pass:android \
  --out /private/tmp/hypergolic-published-update.apk \
  /private/tmp/hypergolic-update-aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify \
  /private/tmp/hypergolic-published-update.apk
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 4 \
  /private/tmp/hypergolic-published-update.apk
```

Restore Gradle and confirm `cmp` against its saved copy before installing.
Choose an unlocked, disposable API 36 emulator and use its explicit serial.
The driver never installs or clears application data. Record the exact APK
hash and frozen-source hash from the same checkout:

```sh
shasum -a 256 /private/tmp/hypergolic-published-update.apk
PYTHONPATH=tests/native python3 -B -c \
  'from pathlib import Path; import published_update_driver as d; print(d.source_digest(d.source_hashes(Path.cwd())))'
adb -s EXPLICIT_SERIAL install -r /private/tmp/hypergolic-published-update.apk
python3 -B tests/native/published_update_driver.py --source "$PWD" \
  --serial EXPLICIT_SERIAL \
  --package org.nostrocket.hypergolic.publishedupdatefixture \
  --expected-apk-sha256 VERIFIED_APK_SHA256 \
  --expected-source-sha256 VERIFIED_SOURCE_SHA256 \
  --output /private/tmp/hypergolic-android-update-UNIQUE --launch
```

For changed access, use the same built fixture package after a clean disposable
fixture install. Compute the source hash and run the dedicated driver:

```sh
PYTHONPATH=tests/native python3 -B -c \
  'from pathlib import Path; import changed_access_driver as d; print(d.source_digest(d.source_hashes(Path.cwd())))'
python3 -B tests/native/changed_access_driver.py --source "$PWD" \
  --serial EXPLICIT_SERIAL \
  --package org.nostrocket.hypergolic.publishedupdatefixture \
  --expected-apk-sha256 VERIFIED_APK_SHA256 \
  --expected-source-sha256 VERIFIED_CHANGED_ACCESS_SOURCE_SHA256 \
  --output /private/tmp/hypergolic-android-changed-access-UNIQUE --launch
```

For iOS, use the same public-only entry and a separate Simulator bundle ID.
The normal app requires physical-device identity storage, so the Simulator
fixture does not prove production iOS key protection.

```sh
# Configure the pinned tools described in docs/development.md.
# Select full Xcode as described in docs/development.md.
xcodebuild -workspace ios/Hypergolic.xcworkspace -scheme Hypergolic \
  -configuration Release -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=EXPLICIT_SIMULATOR_UUID' \
  -derivedDataPath /private/tmp/hypergolic-published-update-ios-build \
  CODE_SIGNING_ALLOWED=NO \
  PRODUCT_BUNDLE_IDENTIFIER=org.nostrocket.hypergolic.publishedupdatefixture \
  ENTRY_FILE=tests/native/published-update-fixtures/index.tsx build
xcrun simctl install EXPLICIT_SIMULATOR_UUID \
  /private/tmp/hypergolic-published-update-ios-build/Build/Products/Release-iphonesimulator/Hypergolic.app
python3 -B tests/native/ios-driver.py --udid EXPLICIT_SIMULATOR_UUID \
  --bundle-id org.nostrocket.hypergolic.publishedupdatefixture \
  --repo "$PWD" --output /private/tmp/hypergolic-ios-update-UNIQUE \
  published-update
```

After a clean disposable fixture install, run the separate `changed-access`
scenario with the same bundle ID and a new output directory:

```sh
python3 -B tests/native/ios-driver.py --udid EXPLICIT_SIMULATOR_UUID \
  --bundle-id org.nostrocket.hypergolic.publishedupdatefixture \
  --repo "$PWD" --output /private/tmp/hypergolic-ios-changed-access-UNIQUE \
  changed-access
```

Inspect the result JSON and screenshots. These journeys establish explicit
first-open review, v1 native guest readiness, rejection retaining v1,
acceptance replacing it with v2, v2 restoration after a cold app restart,
rejection of an older available revision, and background revocation followed
by an explicit retry of v2 on the named Simulator/emulator builds. The
changed-access journey separately checks that declining expanded access leaves
v1 connected and that accepting both reviews replaces it with v2. The fixture
does not issue a guest signing request; its injected signing and publication
effects throw, so these journeys make no native-signing claim. They do not
establish live relay/Blossom transport, physical iPhone identity security, or
older Android compatibility.

### API 29/WebView 91 compatibility run — 25 September 2026

The final trusted host also passed both signed embedded journeys on an Android
API 29 ARM64 emulator with bundled WebView 91. The same isolated fixture APK
ran the unchanged-access update and the separate `theme, relay` changed-access
review. Each native driver now scrolls until the current-event row is visible
before applying its existing exact publisher/app/event/access assertions; API 29
exposes the review across more than one accessibility viewport. The original
pre-adaptation failure receipt remains alongside the final passing receipts in
the private project checkpoint. The APK SHA-256 was
`f0b04111812beb066e7cb4ada83f877efcacb5718db71bd6dcebd389e945bf38`.
These embedded fixtures do not prove live public relay update retrieval.

The final trusted runtime was rebuilt in the isolated iOS 26.5 Simulator
Release fixture on 25 September 2026. After clearing only the disposable
fixture container, XCTest passed all seven unchanged-access update checks and
all five changed-access checks with the bundled `host.js` matching SHA-256
`2098a63671ce05a3f6c5dbdeaa4fe9f55e40eb078b8af0431b500c7554eb5281`.
An initial run rejected the non-empty fixture workspace, as intended; its
failed receipt is preserved separately. This remains embedded public-only QA.
