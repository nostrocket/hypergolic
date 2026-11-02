# Approval proof fixtures

These templates preserve the test-only app entries used by the native approval
proofs. Materialize them under `.tools/`; never use either entry for a normal
application build.

## iOS public rejection fixture

This fixture composes the production shell, runtime, approval service, native
port, SQLite workspace, and `createApprovalOwner`. Its identity is the labelled
public scalar-2 public key. Its signing and publication effects always fail. It
does not open the protected iOS identity store.

From the repository root:

```sh
mkdir -p .tools/approval-fixture
cp tests/native/approval-fixtures/ios-public-entry.tsx.template .tools/approval-fixture/index.tsx
cmp tests/native/approval-fixtures/ios-public-entry.tsx.template .tools/approval-fixture/index.tsx

# Select full Xcode as described in docs/development.md.
export ENTRY_FILE="$PWD/.tools/approval-fixture/index.tsx"
export DERIVED_DATA=/private/tmp/hypergolic-ios-approval-fixture-derived
xcodebuild -workspace ios/Hypergolic.xcworkspace \
  -scheme Hypergolic \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED_DATA" \
  PRODUCT_BUNDLE_IDENTIFIER=org.nostrocket.hypergolic.approvalfixture \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Choose an already-booted disposable Simulator explicitly. Reset and install
only the isolated fixture bundle, then run the existing public UI journey into
a new output directory:

```sh
export UDID=<chosen-simulator-udid>
export APP="$DERIVED_DATA/Build/Products/Release-iphonesimulator/Hypergolic.app"
xcrun simctl uninstall "$UDID" org.nostrocket.hypergolic.approvalfixture 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

python3 tests/native/ios-driver.py \
  --udid "$UDID" \
  --bundle-id org.nostrocket.hypergolic.approvalfixture \
  --repo "$PWD" \
  --expected-title 'Approval Lab 4' \
  approval-review \
  --output /private/tmp/hypergolic-ios-approval-review
```

The journey never taps **Approve once**. It proves public review, rejection,
queue pause/resume, and background pause on the Simulator. It does not prove
protected storage, device authentication, signing, publication, screen-capture
behavior, or physical-device behavior.

## Android loopback publication fixture

Materialize the entry and start the owned loopback relay in a separate terminal:

```sh
cp tests/native/approval-fixtures/android-relay-entry.ts.template .tools/approval-relay-entry.ts
cmp tests/native/approval-fixtures/android-relay-entry.ts.template .tools/approval-relay-entry.ts

export RELAY_DIR=/private/tmp/hypergolic-approval-relay
node tests/relay/native-review-server.mjs --output "$RELAY_DIR" --mode accept
```

In the build terminal, read the chosen port from the server's private receipt:

```sh
# Configure the pinned tools described in docs/development.md.
export READY="$RELAY_DIR/ready.json"
export EXPO_PUBLIC_APPROVAL_RELAY_PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$READY")"
```

Prepare the generated Android project manually and inspect the resulting diff:

1. Save exact copies of `android/app/build.gradle` and
   `android/app/src/main/AndroidManifest.xml` outside the repository.
2. Keep the generated Gradle namespace unchanged. Replace only the application
   ID with `org.nostrocket.hypergolic.identityfixture`.
3. Replace the generated `react.entryFile` value with
   `file('../../.tools/approval-relay-entry.ts')`.
4. Add `android:usesCleartextTraffic="true"` only to the generated isolated
   test application's `<application>` element.
5. Arrange unconditional cleanup so both generated files are restored byte for
   byte even if the build or driver fails.

Build and sign a fresh isolated APK:

```sh
EXPO_PUBLIC_APPROVAL_RELAY_PORT="$EXPO_PUBLIC_APPROVAL_RELAY_PORT" \
  android/gradlew -p android :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a --console=plain

export APK=/private/tmp/hypergolic-approval-relay.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign \
  --ks android/app/debug.keystore \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$APK" \
  android/app/build/outputs/apk/release/app-release-unsigned.apk
```

After verifying the saved Gradle and manifest bytes were restored, seal the
fixture, source, and APK hashes. Install on the explicitly chosen disposable
test emulator, preserving its prepared public scalar-2 fixture state, and add
only the owned reverse mapping:

```sh
export SERIAL=<chosen-emulator-serial>
adb -s "$SERIAL" install -r "$APK"
adb -s "$SERIAL" reverse "tcp:$EXPO_PUBLIC_APPROVAL_RELAY_PORT" "tcp:$EXPO_PUBLIC_APPROVAL_RELAY_PORT"

python3 tests/native/approval_publication.py \
  --source "$PWD" \
  --serial "$SERIAL" \
  --expected-apk-sha256 "$(shasum -a 256 "$APK" | awk '{print $1}')" \
  --relay-ready "$READY" \
  --output /private/tmp/hypergolic-approval-publication \
  approval-publication
```

Use `--revocation-only` for the separate held-upgrade background-revocation
journey described in `tests/native/approval-publication.md`. When finished,
install the normal isolated fixture APK again, remove only the owned reverse
mapping, and stop the owned loopback server:

```sh
adb -s "$SERIAL" reverse --remove "tcp:$EXPO_PUBLIC_APPROVAL_RELAY_PORT"
```

This Android fixture redirects only the three reviewed relay URLs to loopback.
It proves isolated emulator signing and local wire behavior for the public test
identity. It does not prove public relay delivery, production TLS or DNS policy,
iOS behavior, physical-device behavior, or safety for a real identity. The
cleartext exception belongs only to the generated isolated test application.
