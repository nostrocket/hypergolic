# Development

Use pnpm with the tracked lockfiles. Native modules require local Android/iOS
builds. Generated `android/` and `ios/` directories are ignored; keep permanent
changes in app configuration, config plugins and modules.

## Toolchain

| Component | Repository pin or requirement |
| --- | --- |
| Node / pnpm | 24.20.0 / 10.34.5 |
| Expo / React Native / React | 57.0.20 / 0.86.3 / 19.2.3 |
| Java | Temurin 17.0.20.1+1; CI notation `17.0.20+101` |
| Android SDK / Build Tools | API 36 / 36.0.0 |
| Android NDK / CMake | 27.1.12297006 / 3.22.1 |
| iOS | Mac with full Xcode and CocoaPods; deployment target iOS 18.4 |

The manifests, lockfiles and config plugins own package and native dependency
versions. Current native compilation uses Xcode 27.1; toolchain availability does
not establish device compatibility. Local `.tools/` helpers are optional, ignored and not part of a fresh
clone. Configure `JAVA_HOME`, `ANDROID_HOME` and `PATH` for your installed tools.

## Install

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run runtime:install
pnpm run quality:install
```

The root, runtime, quality tools and individual lab projects use separate
lockfiles. Install each lab in its own directory before running its tests.
Frozen installs preserve the reviewed graph, patches and package-resolution
policy. Do not replace lockfiles or bypass policy to make installation succeed.

## Android

Install the SDK components above and make `adb` available. Start an emulator or
connect a development device:

```sh
pnpm run prebuild:android
pnpm run android
```

The Debug app needs Metro. For an unsigned standalone ARM64 build:

```sh
pnpm run prebuild:android
cd android
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
cd ..
```

On Windows, use `gradlew.bat`. The output is
`android/app/build/outputs/apk/release/app-release-unsigned.apk`. It embeds
JavaScript and must be signed before installation. Local Android builds do not
require EAS or an Expo account; Gradle and package registries remain dependencies.

## iOS development

Select full Xcode and generate the native project:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
pnpm run prebuild:ios
cd ios
pod install
cd ..
```

Run CocoaPods from `ios/`: the autolinker resolves
`Podfile.properties.json` relative to its working directory. App configuration
builds the selected native dependencies from source and applies tracked codec
patches and notice guards. Keep those hooks intact.

For a physical iPhone, pair it with Xcode, enable Developer Mode and select a
development team for the Hypergolic target in `ios/Hypergolic.xcworkspace`.
Then run:

```sh
pnpm exec expo run:ios --device
```

Keep Metro running and reachable from the phone for a Debug build. The normal
app requires a physical iPhone for protected identity storage. Public-identity
Simulator fixtures have separate entry points and cannot prove physical key
protection or OS authentication. See the [native harnesses](../tests/native/README.md).

## Quality gates

```sh
pnpm run check
pnpm run export:android
pnpm run export:ios
```

`check` runs TypeScript, Expo Doctor, React Doctor, aislop and dependency audits
for the root, runtime and quality-tool lockfiles. High/critical audit findings
block the gate. A successful export is a JavaScript bundle, not an installable
native build. Report each result and any blocked or skipped stage separately.

Both final React Doctor and aislop scores must reach 100/100 without hiding
findings. The standard local React Doctor command disables telemetry and its
scoring service; clean local diagnostics do not provide a numeric score. Full
quality and dependency closeout remain open. See the
[patch and exception record](dependency-patches.md).

`check` does not run every behavioral test. Run the suites relevant to the change,
for example:

```sh
pnpm run test:shell
pnpm run test:security
pnpm run test:storage
pnpm run test:capabilities
pnpm run test:signer
pnpm run test:quality
```

The root manifest also defines query, subscriptions, resources, uploads, identity,
links, routing, presentation and Outbox suites. Browser runtime checks use:

```sh
pnpm --dir runtime exec playwright install chromium webkit
pnpm run runtime:test
```

Native harnesses require the prerequisites and explicit targets in their local
READMEs. Inspect their documented effects before running them. Use fresh evidence
directories and disposable test identities. Keep private evidence out of Git.
Native/config-plugin changes need regeneration and compilation on each affected
platform, plus focused boundary tests. Compiles, browser tests and Simulator
results do not close full native device acceptance.

## Tester APK command

On macOS or Linux, use an existing signing keystore outside this checkout:

```sh
export HYPERGOLIC_KEYSTORE_PATH="/absolute/private/path/hypergolic-tester.jks"
pnpm run build:tester --check
pnpm run build:tester
```

Set `HYPERGOLIC_KEY_ALIAS` if the keystore contains multiple keys. Password entry
is interactive. `--check` verifies configuration and tool availability without
building or unlocking the key. `--help` describes the supported options. Do not
run concurrent Android prebuild or Gradle jobs while this command owns the build.

Each successful run creates a new directory under `.tools/tester-apks/` with the
signed ARM64 Release APK, `SHA256SUMS` and a `build.json` receipt. The command
verifies app identity, version, permissions, signature and alignment. It does not
create a signing key, increment versions, install, upload or run the full quality
and acceptance gates.

Keep the app ID and signing key stable for updates; increment
`expo.android.versionCode` before distribution. Cold-launch the exact signed APK
with Metro stopped and verify the intended workflow before sharing. Preserve
identity-bearing installations and their data. Packaging is separate from product
and security acceptance. Run `pnpm run test:tester` for the packaging command's
controlled contract tests.

## Dependency provenance

Keep native patches, immutable upstream pins, packaged license originals and
source/notice guards with their owning implementation. Changing a codec or native
dependency needs actual native regeneration; exporting JavaScript is insufficient.
The [dependency notices](native-dependency-notices.md) and
[patch record](dependency-patches.md) explain current bindings and remaining review.

## Continuous integration

The checked-in workflow runs on pushes, pull requests and manual dispatch. It
checks shared behavior separately from quality/audits, builds both JavaScript
exports, compiles unsigned Android and iPhoneOS Release products, and checks the
runtime plus all seven independently locked labs. Browser and conformance coverage
vary by lab; see their manifests.

The iOS compile selects the `xcode-27` preview runner and verifies Xcode 27.1 and
SDK 27.1 before building. This hosted configuration has not yet run for this
repository. Keep the local iPhoneOS compile and final signed-device acceptance as
separate gates; neither an iOS export nor a hosted compile replaces them.
