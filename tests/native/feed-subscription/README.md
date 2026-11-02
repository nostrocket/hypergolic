# Native live feed fixture

The isolated public-only `org.nostrocket.hypergolic.feedstreamfixture` loads two
retained Feed Lab WebViews through genuine Kehto/SDK, native stream admission,
production broker/verification and app-only WSS against `wss://nos.lol`. It does
not open the protected identity store, sign, publish or expose native socket tokens
to a guest. Normal application destinations still come from trusted Network settings.

Build the existing native app with `tests/native/feed-subscription/index.tsx` and
the isolated package/bundle identifier. Retain Android's existing MainActivity
class and restore temporary generated Gradle edits. On iOS use `ENTRY_FILE` and
`PRODUCT_BUNDLE_IDENTIFIER` build settings. Follow [development prerequisites](../../../docs/development.md).

Run the owned Android journey on an explicitly selected unlocked test device:

```sh
python3 tests/native/feed-subscription/android-stream.py \
  --serial "$ANDROID_TEST_SERIAL" --apk "$STREAM_FIXTURE_APK" \
  --output "$NEW_EVIDENCE_DIRECTORY"
```

The eight checks cover signed history/EOSE, live delivery beyond the ordinary
27-second lease, switching without reopening sockets, editable retained drafts,
background/foreground reconnect, explicit close, view removal, public-owner
revocation and cold restart without old intent. The public-owner control is an
owner assertion fixture; the separate runtime-owner regression uses a real
confirmed IdentityTransition. Neither proves protected native identity settings.
The driver records installed APK equality, source hashes, actual accessibility,
observed event IDs, native input, connection counters and screenshots. Inspect
screenshots independently; successful automation does not mark them reviewed.

Use the owned XCTest project and `FeedStreamTests/testLiveLifecycle` for iOS.
It attaches seven screenshots, observed event IDs and an eight-check report only
after all assertions pass. Verify installed build equality and source seals
separately; retain failed attempts as diagnostic evidence.

`observe-public.mjs PRIVATE_OUTPUT [DURATION_MS]` independently reads and verifies
signed public kind-1 events without publishing. It bounds runtime to five minutes
and retains at most 512 ID/content-hash observations. Compare actual native IDs
with this independent observer, distinguishing stored from post-EOSE arrivals.

## Diagnostic SDK/native faults

`Controlled stream faults` runs nine cases: valid post-EOSE delivery, duplicate
suppression, invalid signature, wrong filter, foreign server subscription ID,
frame-rate flood, oversized frame, view revocation and paused owner revocation.
Only frame input is doubled. SDK, Kehto, immutable native stream admission,
captured native pushes, event validators and ordinary close composition stay real.
Delayed callbacks arrive even after cancellation; receipts count actual attempts,
cancellation, late frames and canonical event/EOSE/closed pushes. This is separate
from the real WSS lifecycle journey and native socket/TLS proofs.

```sh
python3 tests/native/feed-subscription/android-matrix.py \
  --serial "$ANDROID_TEST_SERIAL" --apk "$STREAM_FIXTURE_APK" \
  --output "$NEW_FAULT_EVIDENCE_DIRECTORY"
```

For iOS select `FeedStreamTests/testStreamFaultMatrix`. Native Java/Swift registry
proofs in `tests/native/relay-subscription` cover immutable one-use admission,
process/session bounds, exact pending expiry, retained accepted lifetime and
foreground/generation revocation with the production capability lease registry.
They are registry proofs, not WebView or physical-device evidence.
