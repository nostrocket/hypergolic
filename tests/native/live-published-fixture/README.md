# Live published napplet fixture

This isolated Android/iOS entry uses a public-only identity and the app's real
native WSS lookup, native HTTPS fetch, signed-artifact verifier, first-open review,
and one-use host handoff. Its signing and publication effects always fail. Build it
under a separate package/bundle identifier; never use it as the normal app entry.

The external test candidate is the public `file-browser` kind-35129 coordinate
shown in `index.tsx`. On 25 September 2026 its signed event
`a3c01be3f0d75cd8ff758c78f71ab9446487f01b791f53ac141fce15d1214d0d`
was retrieved from `wss://nos.lol`. The verified publisher is
`266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5`.
Its `/index.html` hash is
`191cd5d503d588ed94eec6ebda80c4054f4cc2df6074228eeb0d8eee388ce6c5`;
its signed access list contains only `theme`. A public relay/Blossom release may
change or disappear, so validate these exact values at each native checkpoint.
The read-only pinned probe receipt is in the private project checkpoint.

The **Probe native source** control retrieves and verifies the signed event,
fetches the signed Blossom URL directly through the native port, then verifies
that the shared source reads both the known-good hint and the complete signed
hint list. It does not execute the guest. The separate Settings journey pastes
the same naddr, shows publisher/event/access review, accepts first-open consent,
and observes the native hosted guest. The candidate's own file browser reports
filesystem unavailable because its manifest requests only `theme`; that is not
a proof of functional file access.

Use the isolated Release build and generated-file restoration pattern in
[the signed-update fixture guide](../published-update-fixtures/README.md),
substituting `tests/native/live-published-fixture/index.tsx` as the entry and
`org.nostrocket.hypergolic.livepublishedfixture` as the package/bundle ID.
Preserve separate APK/bundle hashes, source hashes, screenshots, and a native UI
receipt for each platform. Do not install over the normal app or use a real nsec.

On 25 September 2026, the Android API 36 emulator and iPhone 17 Pro iOS 26.5
Simulator both passed native relay/HTTPS artifact verification, exact first-open
review, consent, and visible connected guest. These public-only fixtures do not
prove protected production identity, guest signing, functional filesystem,
physical iPhone security, older Android, or a live published update.

### Older Android and final-runtime rerun — 25 September 2026

The same public-only journey passed on Android API 29 with bundled WebView
91.0.4472.114. Run the reusable source-bound driver with an explicit fixture APK
and serial, for example:

```sh
python3 tests/native/live_published_driver.py \
  --serial emulator-5564 \
  --package org.nostrocket.hypergolic.livepublishedfixture \
  --apk /path/to/live-published-fixture.apk \
  --output /path/to/private-receipt --reset-fixture
```

`--reset-fixture` clears only that disposable fixture package. The run checks the
installed APK hash, exact native probe, consent fields, and connected guest; its
receipt and screenshots belong in the private Notes checkpoint. The normal
Release app also retained its public npub and connected bundled UX Lab over a
cold restart on API 29. These are different journeys.

On an API 26 emulator, the bundled WebView 58 lacks the required native
`WEB_MESSAGE_LISTENER`. The public source probe and first-open review worked,
but the host refused guest execution with `webview-update-required`. The normal
Release app likewise retained its public npub across restart and refused the
bundled guest. This is a safe compatibility limit, not an API 26 guest pass.
The final trusted host was rebuilt on iOS 26.5 Simulator and again passed the
source probe and three first-open checks.

### Bounded rerun and iOS scenario — 28 September 2026

The public-only fixture now shows a bounded native probe error detail, and the
Android driver stops promptly on an observed probe failure instead of waiting
for a success-only timeout. A fresh API 29/WebView 91 Release fixture initially
reached manifest verification without finding its pinned signed event. A clean
rerun then passed all three native checks: 56,974 verified HTML bytes, exact
publisher/event/theme consent, and `Runtime connected`. The passing signed
fixture APK SHA-256 is
`a03b2d26f4e6dde7c34764b560526c37a10e5f8700923beffa6588c70f504461`.
Both failed and passing receipts are retained in the private project checkpoint;
the initial failure is not counted as a pass.

The iOS Simulator fixture builds with the same diagnostic and now has a
source-bound `live-published` XCTest scenario. Run it only against the separate
public-only bundle on an explicitly named booted Simulator:

```sh
python3 -B tests/native/ios-driver.py --udid EXPLICIT_SIMULATOR_UUID \
  --bundle-id org.nostrocket.hypergolic.livepublishedfixture \
  --repo "$PWD" --expected-title Hypergolic \
  --output /private/tmp/hypergolic-ios-live-published-UNIQUE \
  --timeout 60 live-published
```

The 28 September iPhone 17 Pro/iOS 26.5 Simulator rerun did **not** pass the
full journey. One attempt verified the exact native relay/HTTPS artifact and
then Settings returned its generic verification error before the first-open
review. A clean second attempt reported that the pinned signed event was absent
from the relay result during the probe. The fixture's public third-party event
is therefore an intermittent test dependency. These attempts do not establish
an iOS transport regression or an iOS end-to-end pass on the changed source.
The separately prepared disposable two-revision QA publisher remains the
preferred way to make the live update journey repeatable, pending the publisher
choice before public upload and publication.

### Current-source iOS rerun — 28 September 2026

The separate iPhone 17 Pro/iOS 26.5 Simulator Release fixture was rebuilt
from the current source. Its JavaScript bundle SHA-256 is
`4043383f58894f028ef31a1fb8131209bbf86aa009c97b39d3a27cb5dcea798a`.
The public-only fixture now records bounded Settings relay/HTTPS source stages,
and XCTest includes that stage when the ordinary open fails. After clean
disposable installs, the first run verified the native source but Settings
returned its generic verification error; the second run failed the initial
native relay query. The third run passed all three source-bound XCTest checks:
exact signed native relay/HTTPS artifact, publisher/event/theme review, and
connected guest. The source and installed bundle stayed unchanged during that
pass. Review and connected screenshots were inspected. A separate cold launch
showed the file-browser UI and its expected `Filesystem unavailable` message;
the manifest grants `theme` only. Both failed receipts are retained alongside
the pass. This intermittent external candidate still cannot substitute for a
controlled live-update release or physical-device acceptance.

### Current-source Android API 29 rerun — 28 September 2026

The rebuilt, debug-key-signed public-only ARM64 fixture APK SHA-256 is
`89cc258b797204e52cb430764c4cda568ad1a757b9dc3c1b7355f89dd42772ac`.
Its generated Gradle package/entry edit was restored byte-identically. On
Android API 29 with WebView 91, the first clean run did not find the pinned
signed event in the relay result. The second clean run passed all three checks:
exact 56,974-byte native relay/HTTPS artifact, publisher/event/`theme`
first-open review, and visibly connected guest. The Android driver now stops
on an explicit Settings error and reports the QA-only source stage. A separate
force-stop and cold launch restored `file-browser` and `Runtime connected` in
the native accessibility hierarchy; the screenshot shows the guest UI and
expected filesystem denial. The failed and passing receipts remain distinct.
This is current Android first-open and restoration evidence, not a live
published update or functional filesystem proof.
