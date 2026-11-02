# Native routing evidence

These fixtures use the ordinary IdentityShell, signed-manifest admission, original
pinned SDK and production native routing transports. Products use an isolated
package and disposable public test identities. Locally supplied signatures do not
prove external relay discovery, protected keys or physical-device behavior.

Run from the source root with its pinned toolchain. Replace the explicit device
and unique output placeholders. One Android accessibility observer may run at a
time. The `settings` and `protocol` suites require a clean isolated app store.

```sh
# Configure the pinned tools described in docs/development.md.
# Select full Xcode as described in docs/development.md.
python3 -B tests/native/routing/build.py --platform android --output /tmp/routing-android-build-UNIQUE
.tools/android-sdk/platform-tools/adb -s EXPLICIT_ANDROID_SERIAL install -r /tmp/routing-android-build-UNIQUE/routingfixture.apk
HYPERGOLIC_UPLOAD_UI_DUMP=fast python3 -B tests/native/routing/android.py \
  --serial EXPLICIT_ANDROID_SERIAL --build /tmp/routing-android-build-UNIQUE/build.json \
  --apk /tmp/routing-android-build-UNIQUE/routingfixture.apk --output /tmp/routing-android-journey-UNIQUE
```

The fast observer uses the existing upload driver's compiled UiAutomator observer;
without it omit the environment variable to use the standard observer. Substitute
`settings.py` or `protocol.py` for the respective Android suites.

```sh
python3 -B tests/native/routing/build.py --platform ios --output /tmp/routing-ios-build-UNIQUE
xcrun simctl install EXPLICIT_SIMULATOR_UUID /tmp/routing-ios-build-UNIQUE/derived/Build/Products/Release-iphonesimulator/Hypergolic.app
python3 -B tests/native/routing/ios.py --device EXPLICIT_SIMULATOR_UUID \
  --build /tmp/routing-ios-build-UNIQUE/build.json \
  --app /tmp/routing-ios-build-UNIQUE/derived/Build/Products/Release-iphonesimulator/Hypergolic.app \
  --output /tmp/routing-ios-journey-UNIQUE
```

Use `--suite settings` or `--suite protocol` for separate acceptance suites. Clear
only the isolated fixture package before those suites. `build.py` restores the
ordinary Android entry/signing/package file byte for byte. iOS overrides the entry
and package only for that invocation. The source and actual installed product
fingerprints must match before and after every journey. Keep failed receipts.

The main tracer checks dispatch review/cancellation, exact payloads/topics, inbound
channel ordering, symmetric messages/closure, late SDK retention, switching,
background teardown, native deadlines, review floods, forged sender/control,
third-view channel denial, live delivery controls and peer destruction. Settings
checks default changes, restart, retained closed-handler cold readiness/topic
review, removal without data deletion, reopening, domain denial and identity-local
catalog state. Protocol checks absent handlers/peers and ambiguous signed
publishers/live targets through original SDK results.

`stage-published.mjs` signs the exact HTML with documented public scalars 2 and 3.
Its collision variant shares a dTag with the ordinary peer under another publisher;
its automatic-topic variant is independently hashed and signed. No event is
published. Rebuild/stage after fixture changes before sealing a product.

`pnpm test:routing:native` compiles the production Java/Swift endpoint authority
cores. Shared native lease proofs cover continuous-clock expiry, one-use/replay
and revision denial. These unit proofs are distinct from input-driven journeys.
See [the selected protocol profile](../../../docs/intent-inc.md).
